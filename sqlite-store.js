/*
 * Task Planner storage.
 *
 * Tasks and goals live in one SQLite database (sql.js). Every change is saved
 * to two places on this computer:
 *
 *   1. chrome.storage.local — the primary copy. It survives browser restarts,
 *      extension reloads and updates, and "Clear browsing data". The
 *      unlimitedStorage permission removes its size cap.
 *   2. The extension's private file system (OPFS) — a second, independent copy.
 *
 * Both copies carry a revision number: the newest one wins when the board
 * opens, and a missing or damaged copy is rebuilt from the other. Writes from
 * every open tab (and the toolbar popup) take a shared Web Lock and apply on
 * top of the latest saved revision, so one tab never overwrites another tab's
 * changes. Nothing is ever deleted unless the user deletes it.
 */

const ITEM_TYPES = ["todo", "goal"];
const ITEM_STATUSES = ["todo", "progress", "done"];

class SQLiteTaskStore extends EventTarget {
  constructor() {
    super();
    this.databaseKey = "taskPlannerSQLiteDb";
    this.metaKey = "taskPlannerSQLiteMeta";
    this.preUpgradeKey = "taskPlannerPreUpgradeBackup";
    this.databaseFileName = "task-planner.sqlite3";
    this.changeChannelName = "task-planner-sqlite-changes";
    this.lockName = "task-planner-database";
    this.legacyTodoKey = "newTabTodos";
    this.legacyGoalKey = "newTabGoals";

    this.SQL = null;
    this.db = null;
    this.revision = 0;
    this.savedAt = null;
    this.isReady = false;
    this.notice = null;
    this.health = { primary: "unknown", secondary: "unknown" };

    this.changeChannel = null;
    this.latestKnownRevision = 0;
    this.refreshTask = null;
    this.refreshAgain = false;
    this.localLockQueue = Promise.resolve();
  }

  static isSQLite(bytes) {
    const header = "SQLite format 3\u0000";
    if (!bytes || bytes.length < header.length) return false;

    for (let index = 0; index < header.length; index += 1) {
      if (bytes[index] !== header.charCodeAt(index)) return false;
    }

    return true;
  }

  async init() {
    this.SQL = await initSqlJs({
      locateFile: (file) => this.getRuntimeUrl(`vendor/sql.js/${file}`)
    });

    await this.withLock(() => this.openNewestCopy());
    this.listenForExternalChanges();
    this.requestPersistentStorage();
    this.isReady = true;
  }

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------

  async openNewestCopy() {
    const copies = await Promise.all([
      this.readPrimaryCopy(),
      this.readSecondaryCopy()
    ]);
    const readable = [];

    for (const copy of copies) {
      if (!copy.bytes) continue;

      const db = this.openDatabase(copy.bytes);
      if (!db) {
        copy.unreadable = true;
        console.warn(`Task Planner: ignoring an unreadable ${copy.source} copy.`);
        continue;
      }

      Object.assign(copy, { db }, this.readRevisionInfo(db));
      readable.push(copy);
    }

    // Newest revision first. Copies saved by version 1 have no revision; back
    // then the file-system copy was the main one, so it wins a tie.
    readable.sort(
      (a, b) => b.revision - a.revision || (a.source === "opfs" ? -1 : 1)
    );

    const [newest, ...older] = readable;
    const [primary, secondary] = copies;

    // A copy that couldn't be read may hold newer data than what we can see,
    // so never save over it. (Once it has revision info, the file-system copy
    // is never ahead of the main copy, so there only an old-format copy counts.)
    if (primary.error || (secondary.error && !newest?.hasMeta)) {
      readable.forEach((copy) => copy.db.close());
      throw new Error(
        "Your saved tasks couldn't be read right now. Nothing was changed — reload the page to try again."
      );
    }

    if (!newest) {
      // Every copy is damaged beyond reading: set them aside untouched first.
      const damaged = copies.filter((copy) => copy.unreadable);
      if (damaged.length) await this.keepDamagedCopies(damaged);

      // Otherwise nothing is saved yet: start a new board, bringing along lists
      // from the very first version of the extension if they exist.
      this.db = new this.SQL.Database();
      this.ensureSchema();
      this.mergeRows(await this.readLegacyLists());
      await this.saveAsNewRevision();
      return;
    }

    if (readable.some((copy) => !copy.hasMeta)) {
      await this.keepPreUpgradeCopy(copies);
    }

    this.db = newest.db;
    this.revision = newest.revision;
    this.savedAt = newest.savedAt;

    let changed = this.ensureSchema();
    for (const copy of older) {
      // A copy without revision info is never discarded: anything in it that
      // is missing from the newest copy is merged in.
      if (!copy.hasMeta) {
        const merged = this.mergeRows(this.readItemsFrom(copy.db));
        changed = changed || merged.added + merged.updated > 0;
      }
      copy.db.close();
    }

    const expectedCopies = copies.filter((copy) => copy.supported).length;
    const inSync =
      !changed &&
      newest.hasMeta &&
      readable.length === expectedCopies &&
      readable.every((copy) => copy.revision === newest.revision);

    if (inSync) {
      this.health.primary = "ok";
      this.health.secondary = expectedCopies > 1 ? "ok" : "unavailable";
    } else {
      await this.saveAsNewRevision();
    }
  }

  async readPrimaryCopy() {
    const copy = { source: "storage", supported: true, bytes: null, error: null };

    try {
      const result = await this.readStorage([this.databaseKey]);
      const encoded = result[this.databaseKey];
      if (typeof encoded === "string" && encoded) {
        copy.bytes = this.base64ToBytes(encoded);
      }
    } catch (error) {
      copy.error = error;
      console.warn("Task Planner: could not read the saved copy.", error);
    }

    return copy;
  }

  async readSecondaryCopy() {
    const copy = { source: "opfs", supported: false, bytes: null, error: null };
    const root = await this.getOpfsRoot();
    if (!root) return copy;

    copy.supported = true;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const handle = await root.getFileHandle(this.databaseFileName);
        const file = await handle.getFile();
        copy.bytes = file.size ? new Uint8Array(await file.arrayBuffer()) : null;
        copy.error = null;
        return copy;
      } catch (error) {
        if (error.name === "NotFoundError") return copy;
        copy.error = error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 80));
      }
    }

    console.warn("Task Planner: could not read the file-system copy.", copy.error);
    return copy;
  }

  async readLegacyLists() {
    try {
      const legacy = await this.readStorage([this.legacyTodoKey, this.legacyGoalKey]);
      return this.itemsFromData({
        todos: legacy[this.legacyTodoKey],
        goals: legacy[this.legacyGoalKey]
      });
    } catch (error) {
      console.warn("Task Planner: could not read lists from version 1.", error);
      return [];
    }
  }

  // The first time this version opens data saved by an older version, keep an
  // untouched copy of it, just in case.
  async keepPreUpgradeCopy(copies) {
    try {
      const existing = await this.readStorage([this.preUpgradeKey]);
      if (existing[this.preUpgradeKey]) return;

      const backup = { savedAt: new Date().toISOString() };
      for (const copy of copies) {
        if (copy.bytes) backup[copy.source] = this.bytesToBase64(copy.bytes);
      }
      await this.writeStorage({ [this.preUpgradeKey]: backup });
    } catch (error) {
      console.warn("Task Planner: could not keep a pre-upgrade copy.", error);
    }
  }

  // Throws if the copies can't be set aside, so they are never overwritten.
  async keepDamagedCopies(copies) {
    const saved = { savedAt: new Date().toISOString() };
    for (const copy of copies) saved[copy.source] = this.bytesToBase64(copy.bytes);

    await this.writeStorage({ [`taskPlannerDamagedCopy-${Date.now()}`]: saved });
    this.notice =
      "Your saved board was damaged and couldn't be opened, so a new one was started. The damaged data was kept aside, untouched.";
  }

  openDatabase(bytes) {
    let db = null;

    try {
      db = new this.SQL.Database(bytes);
      db.exec("SELECT count(*) FROM sqlite_master");
      return db;
    } catch (error) {
      db?.close();
      return null;
    }
  }

  readRevisionInfo(db) {
    try {
      const meta = Object.fromEntries(
        this.selectAll("SELECT key, value FROM meta", [], db).map((row) => [
          row.key,
          row.value
        ])
      );
      return {
        hasMeta: true,
        revision: Number(meta.revision) || 0,
        savedAt: meta.saved_at || null
      };
    } catch (error) {
      return { hasMeta: false, revision: 0, savedAt: null };
    }
  }

  ensureSchema() {
    let changed = false;
    const tables = new Set(
      this.selectAll("SELECT name FROM sqlite_master WHERE type = 'table'").map(
        (row) => row.name
      )
    );

    if (!tables.has("items")) {
      this.db.run(`
        CREATE TABLE items (
          id TEXT NOT NULL,
          type TEXT NOT NULL CHECK (type IN ('todo', 'goal')),
          text TEXT NOT NULL,
          completed INTEGER NOT NULL DEFAULT 0,
          in_progress INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT,
          PRIMARY KEY (type, id)
        )
      `);
      changed = true;
    }

    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_items_type_order ON items (type, sort_order)"
    );

    if (!tables.has("meta")) {
      this.db.run(
        "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
      );
      changed = true;
    }

    const columns = this.selectAll("PRAGMA table_info(items)").map(
      (column) => column.name
    );
    if (!columns.includes("updated_at")) {
      this.db.run("ALTER TABLE items ADD COLUMN updated_at TEXT");
      changed = true;
    }

    return changed;
  }

  // ---------------------------------------------------------------------------
  // Keeping tabs in sync
  // ---------------------------------------------------------------------------

  listenForExternalChanges() {
    const hint = (revision) => {
      const value = Number(revision);
      this.latestKnownRevision = Math.max(
        this.latestKnownRevision,
        Number.isFinite(value) ? value : this.revision + 1
      );
      if (this.latestKnownRevision > this.revision) this.scheduleRefresh();
    };

    if (this.hasChromeStorageEvents()) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes[this.metaKey]) {
          hint(changes[this.metaKey].newValue?.revision);
        }
      });
    } else {
      window.addEventListener("storage", (event) => {
        if (event.key !== this.metaKey) return;
        try {
          hint(JSON.parse(event.newValue || "{}").revision);
        } catch (error) {
          hint(undefined);
        }
      });
    }

    if (typeof BroadcastChannel !== "undefined") {
      this.getChangeChannel().addEventListener("message", (event) => {
        if (event.data?.type === "database-updated") hint(event.data.revision);
      });
    }

    // Catch anything missed while this tab was in the background.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.scheduleRefresh();
    });
  }

  scheduleRefresh() {
    if (this.refreshTask) {
      this.refreshAgain = true;
      return this.refreshTask;
    }

    this.refreshTask = this.withLock(() => this.refreshIfStale())
      .catch((error) =>
        console.warn("Task Planner: could not load changes from another tab.", error)
      )
      .finally(() => {
        this.refreshTask = null;
        if (this.refreshAgain) {
          this.refreshAgain = false;
          this.scheduleRefresh();
        }
      });

    return this.refreshTask;
  }

  // Must be called while holding the lock.
  async refreshIfStale() {
    let storedRevision = 0;
    try {
      const stored = await this.readStorage([this.metaKey]);
      storedRevision = Number(stored[this.metaKey]?.revision) || 0;
    } catch (error) {
      return false;
    }
    if (storedRevision <= this.revision) return false;

    const copy = await this.readPrimaryCopy();
    const db = copy.bytes && this.openDatabase(copy.bytes);
    if (!db) return false;

    const info = this.readRevisionInfo(db);
    if (info.revision <= this.revision) {
      db.close();
      return false;
    }

    this.replaceDatabase(db, info);
    this.emitChange("remote");
    return true;
  }

  replaceDatabase(db, info) {
    this.db?.close();
    this.db = db;
    this.ensureSchema();
    this.revision = info.revision;
    this.savedAt = info.savedAt;
  }

  // ---------------------------------------------------------------------------
  // Saving
  // ---------------------------------------------------------------------------

  withLock(task) {
    if (typeof navigator !== "undefined" && navigator.locks?.request) {
      return navigator.locks.request(this.lockName, () => task());
    }

    const run = this.localLockQueue.then(() => task());
    this.localLockQueue = run.catch(() => {});
    return run;
  }

  // Applies a change on top of the latest saved data, then saves it. If it
  // can't be saved, the board goes back to the last saved state and the error
  // is passed on — the board never shows a change that isn't saved.
  mutate(apply) {
    this.assertReady();

    return this.withLock(async () => {
      await this.refreshIfStale();

      const previous = { revision: this.revision, savedAt: this.savedAt };
      const revision = this.revision + 1;
      const savedAt = new Date().toISOString();
      let result;

      this.db.run("BEGIN");
      try {
        result = apply(savedAt);
        this.stampRevision(revision, savedAt);
        this.db.run("COMMIT");
      } catch (error) {
        this.db.run("ROLLBACK");
        throw error;
      }

      this.revision = revision;
      this.savedAt = savedAt;
      this.emitChange("local");

      try {
        await this.persist(revision, savedAt);
      } catch (error) {
        console.error("Task Planner: a change could not be saved.", error);
        await this.restoreLastSavedCopy(previous);
        this.emitChange("revert");
        throw error;
      }

      this.dispatchEvent(new CustomEvent("persisted", { detail: { revision } }));
      return result;
    });
  }

  async saveAsNewRevision() {
    const revision = this.revision + 1;
    const savedAt = new Date().toISOString();
    this.stampRevision(revision, savedAt);

    try {
      await this.persist(revision, savedAt);
      this.revision = revision;
      this.savedAt = savedAt;
    } catch (error) {
      // The data is still open, and the copies it came from are untouched.
      console.error("Task Planner: could not update the saved copies.", error);
    }
  }

  stampRevision(revision, savedAt) {
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)"
    );
    try {
      stmt.run(["revision", String(revision)]);
      stmt.run(["saved_at", savedAt]);
      stmt.run(["schema_version", "2"]);
    } finally {
      stmt.free();
    }
  }

  async persist(revision, savedAt) {
    const bytes = this.db.export();

    try {
      await this.writeStorage({
        [this.databaseKey]: this.bytesToBase64(bytes),
        [this.metaKey]: { revision, savedAt }
      });
      this.health.primary = "ok";
    } catch (error) {
      this.health.primary = "error";
      throw error;
    }

    // Written after the primary copy, so it is never ahead of it.
    this.health.secondary = await this.writeDatabaseToOpfs(bytes);
    this.broadcastChange(revision);
  }

  async restoreLastSavedCopy(previous) {
    for (const read of [
      () => this.readPrimaryCopy(),
      () => this.readSecondaryCopy()
    ]) {
      const copy = await read();
      const db = copy.bytes && this.openDatabase(copy.bytes);
      if (db) {
        this.replaceDatabase(db, this.readRevisionInfo(db));
        return;
      }
    }

    this.revision = previous.revision;
    this.savedAt = previous.savedAt;
  }

  async writeDatabaseToOpfs(bytes) {
    const root = await this.getOpfsRoot();
    if (!root) return "unavailable";

    let writable = null;
    try {
      const handle = await root.getFileHandle(this.databaseFileName, {
        create: true
      });
      writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
      return "ok";
    } catch (error) {
      await writable?.abort().catch(() => {});
      console.warn("Task Planner: could not update the file-system copy.", error);
      return "error";
    }
  }

  // Asks Chrome never to clear the extension's files to free up disk space.
  async requestPersistentStorage() {
    try {
      if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
        await navigator.storage.persist();
      }
    } catch (error) {
      // Best effort: the chrome.storage copy doesn't depend on it.
    }
  }

  // ---------------------------------------------------------------------------
  // Reading items
  // ---------------------------------------------------------------------------

  getItems(type) {
    this.assertReady();

    return this.selectAll(
      `SELECT id, text, completed, in_progress, created_at, updated_at
       FROM items
       WHERE type = ?
       ORDER BY sort_order ASC, rowid ASC`,
      [type]
    ).map((row) => this.rowToItem(row));
  }

  rowToItem(row) {
    return {
      id: String(row.id),
      text: String(row.text ?? ""),
      status: this.rowStatus(row),
      createdAt: String(row.created_at ?? ""),
      updatedAt: String(row.updated_at || row.created_at || "")
    };
  }

  rowStatus(row) {
    if (Number(row.completed)) return "done";
    return Number(row.in_progress) ? "progress" : "todo";
  }

  statusFlags(status) {
    return {
      completed: status === "done" ? 1 : 0,
      inProgress: status === "progress" ? 1 : 0
    };
  }

  orderedIds(type) {
    return this.selectAll(
      "SELECT id FROM items WHERE type = ? ORDER BY sort_order ASC, rowid ASC",
      [type]
    ).map((row) => String(row.id));
  }

  topSortOrder(type) {
    const row = this.selectOne(
      "SELECT MIN(sort_order) AS first FROM items WHERE type = ?",
      [type]
    );
    return row?.first === null || row?.first === undefined ? 0 : Number(row.first) - 1;
  }

  writeOrder(type, ids) {
    const stmt = this.db.prepare(
      "UPDATE items SET sort_order = ? WHERE type = ? AND id = ?"
    );
    try {
      ids.forEach((id, index) => stmt.run([index, type, id]));
    } finally {
      stmt.free();
    }
  }

  // ---------------------------------------------------------------------------
  // Changing items
  // ---------------------------------------------------------------------------

  // New items go to the top of their column.
  addItem(type, text, { id = this.createId(), status = "todo" } = {}) {
    return this.mutate((now) => {
      const flags = this.statusFlags(status);
      this.db.run(
        `INSERT INTO items (id, type, text, completed, in_progress, created_at, updated_at, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, type, text, flags.completed, flags.inProgress, now, now, this.topSortOrder(type)]
      );
      return id;
    });
  }

  updateText(type, id, text) {
    return this.mutate((now) => {
      this.db.run(
        "UPDATE items SET text = ?, updated_at = ? WHERE type = ? AND id = ?",
        [text, now, type, id]
      );
    });
  }

  // Status change from a card button: the item moves to the top of its new column.
  setStatus(type, id, status) {
    return this.mutate((now) => {
      const flags = this.statusFlags(status);
      this.db.run(
        `UPDATE items
         SET completed = ?, in_progress = ?, updated_at = ?, sort_order = ?
         WHERE type = ? AND id = ?`,
        [flags.completed, flags.inProgress, now, this.topSortOrder(type), type, id]
      );
    });
  }

  // Drag and drop: puts the item in `status`, just before `beforeId`, or at
  // the end of that column when `beforeId` is null.
  moveItem(type, id, status, beforeId = null) {
    return this.mutate((now) => {
      const current = this.selectOne(
        "SELECT completed, in_progress FROM items WHERE type = ? AND id = ?",
        [type, id]
      );
      if (!current) return false;

      if (this.rowStatus(current) !== status) {
        const flags = this.statusFlags(status);
        this.db.run(
          "UPDATE items SET completed = ?, in_progress = ?, updated_at = ? WHERE type = ? AND id = ?",
          [flags.completed, flags.inProgress, now, type, id]
        );
      }

      const order = this.orderedIds(type).filter((itemId) => itemId !== id);
      const index = beforeId ? order.indexOf(beforeId) : -1;
      order.splice(index === -1 ? order.length : index, 0, id);
      this.writeOrder(type, order);
      return true;
    });
  }

  // Returns what's needed to undo the delete.
  deleteItem(type, id) {
    return this.mutate(() => {
      const row = this.selectOne(
        "SELECT * FROM items WHERE type = ? AND id = ?",
        [type, id]
      );
      if (!row) return null;

      const order = this.orderedIds(type);
      const index = order.indexOf(String(id));
      this.db.run("DELETE FROM items WHERE type = ? AND id = ?", [type, id]);
      return { row, index, nextId: order[index + 1] ?? null };
    });
  }

  restoreItem(type, snapshot) {
    return this.mutate(() => {
      const { row } = snapshot;
      const id = String(row.id);
      if (this.selectOne("SELECT id FROM items WHERE type = ? AND id = ?", [type, id])) {
        return false;
      }

      this.db.run(
        `INSERT INTO items (id, type, text, completed, in_progress, created_at, updated_at, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
        [id, type, row.text, row.completed, row.in_progress, row.created_at, row.updated_at ?? null]
      );

      const order = this.orderedIds(type).filter((itemId) => itemId !== id);
      let index = snapshot.nextId ? order.indexOf(snapshot.nextId) : -1;
      if (index === -1) index = Math.min(snapshot.index, order.length);
      order.splice(index, 0, id);
      this.writeOrder(type, order);
      return true;
    });
  }

  // Restores from a backup: adds items missing from the board and takes the
  // backup's version of an item only if it was edited more recently. Nothing
  // on the board is ever removed.
  mergeItems(items) {
    return this.mutate(() => this.mergeRows(items));
  }

  mergeRows(items) {
    const result = { added: 0, updated: 0, unchanged: 0 };
    const nextOrder = new Map();

    for (const item of items) {
      if (!nextOrder.has(item.type)) {
        const row = this.selectOne(
          "SELECT MAX(sort_order) AS last FROM items WHERE type = ?",
          [item.type]
        );
        nextOrder.set(
          item.type,
          row?.last === null || row?.last === undefined ? 0 : Number(row.last) + 1
        );
      }

      const existing = item.id
        ? this.selectOne(
            "SELECT text, completed, in_progress, created_at, updated_at FROM items WHERE type = ? AND id = ?",
            [item.type, item.id]
          )
        : this.selectOne(
            "SELECT text, completed, in_progress, created_at, updated_at FROM items WHERE type = ? AND text = ?",
            [item.type, item.text]
          );
      const flags = this.statusFlags(item.status);

      if (!existing) {
        const order = nextOrder.get(item.type);
        nextOrder.set(item.type, order + 1);
        this.db.run(
          `INSERT INTO items (id, type, text, completed, in_progress, created_at, updated_at, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            item.id ?? this.createId(),
            item.type,
            item.text,
            flags.completed,
            flags.inProgress,
            item.createdAt,
            item.updatedAt,
            order
          ]
        );
        result.added += 1;
        continue;
      }

      const differs =
        existing.text !== item.text || this.rowStatus(existing) !== item.status;
      const currentStamp = existing.updated_at || existing.created_at || "";
      if (item.id && differs && item.updatedAt > currentStamp) {
        this.db.run(
          "UPDATE items SET text = ?, completed = ?, in_progress = ?, updated_at = ? WHERE type = ? AND id = ?",
          [item.text, flags.completed, flags.inProgress, item.updatedAt, item.type, item.id]
        );
        result.updated += 1;
      } else {
        result.unchanged += 1;
      }
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Backups
  // ---------------------------------------------------------------------------

  exportBytes() {
    this.assertReady();
    return this.db.export();
  }

  exportData() {
    const serialize = ({ id, text, status, createdAt, updatedAt }) => ({
      id,
      text,
      status,
      createdAt,
      updatedAt
    });

    return {
      app: "Task Planner",
      format: 2,
      exportedAt: new Date().toISOString(),
      tasks: this.getItems("todo").map(serialize),
      goals: this.getItems("goal").map(serialize)
    };
  }

  // Reads the items out of a Task Planner database file (for example one from
  // the backup folder).
  readItemsFromBytes(bytes) {
    if (!this.SQL) throw new Error("Storage is not ready yet.");

    const db = this.openDatabase(bytes);
    if (!db) throw new Error("This file is not a SQLite database.");

    try {
      const table = this.selectOne(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'items'",
        [],
        db
      );
      if (!table) throw new Error("This database has no Task Planner items.");
      return { items: this.readItemsFrom(db), ...this.readRevisionInfo(db) };
    } finally {
      db.close();
    }
  }

  readItemsFrom(db) {
    const columns = this.selectAll("PRAGMA table_info(items)", [], db).map(
      (column) => column.name
    );
    if (!columns.length) return [];

    const updatedAt = columns.includes("updated_at")
      ? "updated_at"
      : "NULL AS updated_at";

    return this.selectAll(
      `SELECT id, type, text, completed, in_progress, created_at, ${updatedAt}
       FROM items
       ORDER BY type, sort_order, rowid`,
      [],
      db
    )
      .filter((row) => ITEM_TYPES.includes(row.type) && String(row.text ?? "").trim())
      .map((row) => ({ type: row.type, ...this.rowToItem(row) }));
  }

  // Accepts this app's JSON backups as well as plain lists of items.
  itemsFromData(data) {
    const items = [];
    const add = (list, type) => {
      if (!Array.isArray(list)) return;
      for (const entry of list) items.push(this.normalizeIncoming(entry, type));
    };

    if (Array.isArray(data)) {
      add(data, "todo");
    } else if (data && typeof data === "object") {
      add(data.tasks ?? data.todos ?? data[this.legacyTodoKey], "todo");
      add(data.goals ?? data[this.legacyGoalKey], "goal");
      add(data.items, "todo");
    }

    return items.filter(Boolean);
  }

  normalizeIncoming(entry, fallbackType) {
    if (!entry || typeof entry !== "object") return null;

    const text = typeof entry.text === "string" ? entry.text.trim() : "";
    if (!text) return null;

    const type = ITEM_TYPES.includes(entry.type) ? entry.type : fallbackType;
    const status = ITEM_STATUSES.includes(entry.status)
      ? entry.status
      : entry.completed
        ? "done"
        : entry.inProgress || entry.in_progress
          ? "progress"
          : "todo";
    const createdAt =
      this.toIsoDate(entry.createdAt ?? entry.created_at) ?? new Date().toISOString();
    const updatedAt = this.toIsoDate(entry.updatedAt ?? entry.updated_at) ?? createdAt;
    const id =
      entry.id === undefined || entry.id === null || entry.id === ""
        ? null
        : String(entry.id);

    return { type, id, text, status, createdAt, updatedAt };
  }

  toIsoDate(value) {
    if (value === undefined || value === null || value === "") return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  selectAll(sql, params = [], db = this.db) {
    const stmt = db.prepare(sql);
    const rows = [];

    try {
      stmt.bind(params);
      while (stmt.step()) rows.push(stmt.getAsObject());
    } finally {
      stmt.free();
    }

    return rows;
  }

  selectOne(sql, params = [], db = this.db) {
    return this.selectAll(sql, params, db)[0] ?? null;
  }

  createId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }

    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  emitChange(source) {
    this.dispatchEvent(new CustomEvent("change", { detail: { source } }));
  }

  broadcastChange(revision) {
    if (typeof BroadcastChannel === "undefined") return;

    this.getChangeChannel().postMessage({
      type: "database-updated",
      revision,
      updatedAt: Date.now()
    });
  }

  getChangeChannel() {
    if (!this.changeChannel) {
      this.changeChannel = new BroadcastChannel(this.changeChannelName);
    }

    return this.changeChannel;
  }

  async getOpfsRoot() {
    if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) {
      return null;
    }

    try {
      return await navigator.storage.getDirectory();
    } catch (error) {
      console.warn("Task Planner: the private file system is not available.", error);
      return null;
    }
  }

  async readStorage(keys) {
    if (this.hasChromeStorage()) {
      return (await chrome.storage.local.get(keys)) ?? {};
    }

    const result = {};
    for (const key of keys) {
      const value = localStorage.getItem(key);
      result[key] = value === null ? undefined : JSON.parse(value);
    }
    return result;
  }

  async writeStorage(values) {
    if (this.hasChromeStorage()) {
      await chrome.storage.local.set(values);
      return;
    }

    for (const [key, value] of Object.entries(values)) {
      localStorage.setItem(key, JSON.stringify(value));
    }
  }

  getRuntimeUrl(path) {
    if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
      return chrome.runtime.getURL(path);
    }

    return path;
  }

  hasChromeStorage() {
    return typeof chrome !== "undefined" && Boolean(chrome.storage?.local);
  }

  hasChromeStorageEvents() {
    return typeof chrome !== "undefined" && Boolean(chrome.storage?.onChanged);
  }

  bytesToBase64(bytes) {
    let binary = "";
    const chunkSize = 0x8000;

    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode.apply(
        null,
        bytes.subarray(index, index + chunkSize)
      );
    }

    return btoa(binary);
  }

  base64ToBytes(encoded) {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
  }

  assertReady() {
    if (!this.isReady || !this.db) {
      throw new Error("SQLiteTaskStore has not been initialized.");
    }
  }
}
