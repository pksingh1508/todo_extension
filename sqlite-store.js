class SQLiteTaskStore {
  constructor() {
    this.databaseKey = "taskPlannerSQLiteDb";
    this.databaseFileName = "task-planner.sqlite3";
    this.changeChannelName = "task-planner-sqlite-changes";
    this.legacyTodoKey = "newTabTodos";
    this.legacyGoalKey = "newTabGoals";
    this.SQL = null;
    this.db = null;
    this.changeChannel = null;
    this.loadedDatabaseFromFallback = false;
    this.isReady = false;
    this.writeQueue = Promise.resolve();
  }

  async init() {
    this.SQL = await initSqlJs({
      locateFile: (file) => this.getRuntimeUrl(`vendor/sql.js/${file}`)
    });

    const storedDatabase = await this.getStoredDatabase();
    this.db = storedDatabase
      ? new this.SQL.Database(storedDatabase)
      : new this.SQL.Database();

    this.createSchema();
    await this.migrateLegacyStorage(Boolean(storedDatabase));
    if (this.loadedDatabaseFromFallback) {
      await this.persist();
    }
    this.isReady = true;
  }

  createSchema() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS items (
        id TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('todo', 'goal')),
        text TEXT NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0,
        in_progress INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (type, id)
      )
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_items_type_order
      ON items (type, sort_order)
    `);
  }

  async migrateLegacyStorage(hasStoredDatabase) {
    if (hasStoredDatabase) return;

    const legacy = await this.readStorage([
      this.legacyTodoKey,
      this.legacyGoalKey
    ]);
    const todos = Array.isArray(legacy[this.legacyTodoKey])
      ? legacy[this.legacyTodoKey]
      : [];
    const goals = Array.isArray(legacy[this.legacyGoalKey])
      ? legacy[this.legacyGoalKey]
      : [];

    if (!todos.length && !goals.length) {
      await this.persist();
      return;
    }

    this.replaceItemsInTransaction("todo", todos);
    this.replaceItemsInTransaction("goal", goals);
    await this.persist();
    await this.removeStorage([this.legacyTodoKey, this.legacyGoalKey]);
  }

  async reloadFromStorage() {
    const storedDatabase = await this.getStoredDatabase();
    if (!storedDatabase) return;

    if (this.db) {
      this.db.close();
    }

    this.db = new this.SQL.Database(storedDatabase);
    this.createSchema();
  }

  getItems(type) {
    this.assertReady();

    const items = [];
    const stmt = this.db.prepare(`
      SELECT id, text, completed, in_progress, created_at
      FROM items
      WHERE type = ?
      ORDER BY sort_order ASC, rowid ASC
    `);

    try {
      stmt.bind([type]);
      while (stmt.step()) {
        const row = stmt.getAsObject();
        items.push({
          id: String(row.id),
          text: String(row.text),
          completed: Boolean(row.completed),
          inProgress: Boolean(row.in_progress),
          createdAt: String(row.created_at)
        });
      }
    } finally {
      stmt.free();
    }

    return items;
  }

  async saveItems(type, items) {
    this.assertReady();
    const snapshot = items.map((item) => ({ ...item }));

    const write = this.writeQueue.catch(() => {}).then(async () => {
      this.replaceItemsInTransaction(type, snapshot);
      await this.persist();
    });

    this.writeQueue = write.catch(() => {});
    return write;
  }

  replaceItemsInTransaction(type, items) {
    this.db.run("BEGIN TRANSACTION");

    try {
      this.db.run("DELETE FROM items WHERE type = ?", [type]);
      const stmt = this.db.prepare(`
        INSERT INTO items (
          id,
          type,
          text,
          completed,
          in_progress,
          created_at,
          sort_order
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      try {
        items.forEach((item, index) => {
          const normalizedItem = this.normalizeItem(item);
          stmt.run([
            normalizedItem.id,
            type,
            normalizedItem.text,
            normalizedItem.completed ? 1 : 0,
            normalizedItem.inProgress ? 1 : 0,
            normalizedItem.createdAt,
            index
          ]);
        });
      } finally {
        stmt.free();
      }

      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
  }

  normalizeItem(item) {
    return {
      id:
        item.id === undefined || item.id === null
          ? this.createId()
          : String(item.id),
      text: String(item.text ?? ""),
      completed: Boolean(item.completed),
      inProgress: Boolean(item.inProgress),
      createdAt: item.createdAt ?? new Date().toISOString()
    };
  }

  createId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }

    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  async persist() {
    const bytes = this.db.export();

    if (await this.writeDatabaseToOpfs(bytes)) {
      await this.removeStorage([this.databaseKey]);
    } else {
      await this.writeStorage({
        [this.databaseKey]: this.bytesToBase64(bytes)
      });
    }

    this.broadcastChange();
  }

  async getStoredDatabase() {
    this.loadedDatabaseFromFallback = false;
    const opfsDatabase = await this.readDatabaseFromOpfs();
    if (opfsDatabase) return opfsDatabase;

    const result = await this.readStorage([this.databaseKey]);
    const encodedDatabase = result[this.databaseKey];
    this.loadedDatabaseFromFallback = Boolean(encodedDatabase);
    return encodedDatabase ? this.base64ToBytes(encodedDatabase) : null;
  }

  onDatabaseChanged(callback) {
    if (typeof BroadcastChannel !== "undefined") {
      this.getChangeChannel().addEventListener("message", (event) => {
        if (event.data?.type === "database-updated") {
          callback();
        }
      });
    }

    if (!this.hasChromeStorageEvents()) return;

    chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace === "local" && changes[this.databaseKey]) {
        callback();
      }
    });
  }

  broadcastChange() {
    if (typeof BroadcastChannel === "undefined") return;

    this.getChangeChannel().postMessage({
      type: "database-updated",
      updatedAt: Date.now()
    });
  }

  getChangeChannel() {
    if (!this.changeChannel) {
      this.changeChannel = new BroadcastChannel(this.changeChannelName);
    }

    return this.changeChannel;
  }

  async readDatabaseFromOpfs() {
    const root = await this.getOpfsRoot();
    if (!root) return null;

    try {
      const handle = await root.getFileHandle(this.databaseFileName);
      const file = await handle.getFile();
      if (!file.size) return null;

      return new Uint8Array(await file.arrayBuffer());
    } catch (error) {
      if (error.name !== "NotFoundError") {
        console.warn("Unable to read SQLite database from OPFS:", error);
      }

      return null;
    }
  }

  async writeDatabaseToOpfs(bytes) {
    const root = await this.getOpfsRoot();
    if (!root) return false;

    try {
      const handle = await root.getFileHandle(this.databaseFileName, {
        create: true
      });
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
      return true;
    } catch (error) {
      console.warn("Unable to write SQLite database to OPFS:", error);
      return false;
    }
  }

  async getOpfsRoot() {
    if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) {
      return null;
    }

    try {
      return await navigator.storage.getDirectory();
    } catch (error) {
      console.warn("OPFS is not available for SQLite persistence:", error);
      return null;
    }
  }

  readStorage(keys) {
    if (this.hasChromeStorage()) {
      return new Promise((resolve, reject) => {
        chrome.storage.local.get(keys, (result) => {
          const error = chrome.runtime.lastError;
          if (error) {
            reject(error);
          } else {
            resolve(result || {});
          }
        });
      });
    }

    const result = {};
    keys.forEach((key) => {
      const value = localStorage.getItem(key);
      result[key] = value ? JSON.parse(value) : undefined;
    });
    return Promise.resolve(result);
  }

  writeStorage(values) {
    if (this.hasChromeStorage()) {
      return new Promise((resolve, reject) => {
        chrome.storage.local.set(values, () => {
          const error = chrome.runtime.lastError;
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }

    Object.entries(values).forEach(([key, value]) => {
      localStorage.setItem(key, JSON.stringify(value));
    });
    return Promise.resolve();
  }

  removeStorage(keys) {
    if (this.hasChromeStorage()) {
      return new Promise((resolve, reject) => {
        chrome.storage.local.remove(keys, () => {
          const error = chrome.runtime.lastError;
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }

    keys.forEach((key) => localStorage.removeItem(key));
    return Promise.resolve();
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
