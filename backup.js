/*
 * Optional backup folder.
 *
 * The user picks a folder on their computer (for example Documents). After
 * every change the whole board is written there as task-planner.sqlite3, and
 * the first save of each day also keeps a dated copy in daily-backups/. The
 * files live outside the browser, so they survive even if the extension is
 * removed — connecting the same folder again brings everything back.
 *
 * Old daily copies are never deleted automatically.
 */
class FolderBackup extends EventTarget {
  constructor(store) {
    super();
    this.store = store;
    this.fileName = "task-planner.sqlite3";
    this.dailyFolderName = "daily-backups";
    this.databaseName = "task-planner-backup";
    this.objectStoreName = "handles";
    this.recordKey = "folder";

    this.handle = null;
    this.state = this.isSupported() ? "disconnected" : "unsupported";
    this.lastSavedAt = null;
    this.lastRevision = 0;
    this.lastError = null;
    this.timer = null;
    this.queue = Promise.resolve();
  }

  isSupported() {
    return (
      typeof window.showDirectoryPicker === "function" &&
      typeof indexedDB !== "undefined"
    );
  }

  get folderName() {
    return this.handle?.name ?? "";
  }

  async init() {
    if (!this.isSupported()) return;

    try {
      const record = await this.readRecord();
      if (!record?.handle) {
        this.setState("disconnected");
        return;
      }

      this.handle = record.handle;
      this.lastSavedAt = record.lastSavedAt ?? null;
      this.lastRevision = record.lastRevision ?? 0;

      const permission = await this.handle.queryPermission({ mode: "readwrite" });
      this.setState(permission === "granted" ? "connected" : "paused");

      // Catch up on changes made where the folder couldn't be written (for
      // example in the toolbar popup, or while backups were paused).
      if (this.state === "connected" && this.lastRevision < this.store.revision) {
        this.scheduleSave(0);
      }
    } catch (error) {
      console.warn("Task Planner: could not open the backup folder settings.", error);
      this.lastError = error;
      this.setState(this.handle ? "error" : "disconnected");
    }
  }

  // Call from a click: opens the system folder picker.
  pickFolder() {
    return window.showDirectoryPicker({
      id: "task-planner-backup",
      mode: "readwrite",
      startIn: "documents"
    });
  }

  // Returns the backup already in `handle`, or null if there isn't one.
  async readBackupFrom(handle) {
    try {
      const fileHandle = await handle.getFileHandle(this.fileName);
      const file = await fileHandle.getFile();
      if (!file.size) return null;

      return {
        bytes: new Uint8Array(await file.arrayBuffer()),
        modifiedAt: new Date(file.lastModified)
      };
    } catch (error) {
      if (error.name === "NotFoundError") return null;
      throw error;
    }
  }

  async connect(handle) {
    this.handle = handle;
    this.lastSavedAt = null;
    this.lastRevision = 0;
    await this.writeRecord();
    this.setState("connected");
    return this.saveNow();
  }

  // Call from a click: asks Chrome to let the extension write to the folder again.
  async resume() {
    if (!this.handle) return false;

    const permission = await this.handle.requestPermission({ mode: "readwrite" });
    if (permission !== "granted") {
      this.setState("paused");
      return false;
    }

    this.setState("connected");
    return this.saveNow();
  }

  async disconnect() {
    clearTimeout(this.timer);
    this.handle = null;
    this.lastSavedAt = null;
    this.lastRevision = 0;
    this.lastError = null;
    await this.deleteRecord();
    this.setState("disconnected");
  }

  scheduleSave(delay = 600) {
    if (this.state !== "connected") return;

    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.saveNow(), delay);
  }

  saveNow() {
    clearTimeout(this.timer);
    const run = this.queue.then(() => this.writeBackup());
    this.queue = run.catch(() => {});
    return run;
  }

  async writeBackup() {
    if (!this.handle) return false;

    try {
      // Hold the database lock so the newest revision is what gets written,
      // even when several tabs are saving.
      await this.store.withLock(async () => {
        await this.store.refreshIfStale();
        const bytes = this.store.exportBytes();
        await this.writeFile(this.handle, this.fileName, bytes);
        await this.writeDailyCopy(bytes);
        this.lastRevision = this.store.revision;
      });

      this.lastSavedAt = new Date().toISOString();
      this.lastError = null;
      await this.writeRecord();
      this.setState("connected");
      return true;
    } catch (error) {
      console.warn("Task Planner: could not write to the backup folder.", error);
      this.lastError = error;
      this.setState(
        error.name === "NotAllowedError" || error.name === "SecurityError"
          ? "paused"
          : "error"
      );
      return false;
    }
  }

  async writeDailyCopy(bytes) {
    const folder = await this.handle.getDirectoryHandle(this.dailyFolderName, {
      create: true
    });
    const name = `task-planner-${this.localDateStamp()}.sqlite3`;

    try {
      await folder.getFileHandle(name);
      return; // Today's copy already exists.
    } catch (error) {
      if (error.name !== "NotFoundError") throw error;
    }

    await this.writeFile(folder, name, bytes);
  }

  async writeFile(directory, name, bytes) {
    const fileHandle = await directory.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();

    try {
      await writable.write(bytes);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      throw error;
    }
  }

  localDateStamp(date = new Date()) {
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  setState(state) {
    this.state = state;
    this.dispatchEvent(new Event("statechange"));
  }

  // The folder handle is kept in IndexedDB so it's remembered between visits.

  openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore(this.objectStoreName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async runRequest(mode, createRequest) {
    const db = await this.openDatabase();

    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction(this.objectStoreName, mode);
        const request = createRequest(transaction.objectStore(this.objectStoreName));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      db.close();
    }
  }

  readRecord() {
    return this.runRequest("readonly", (objectStore) =>
      objectStore.get(this.recordKey)
    );
  }

  writeRecord() {
    return this.runRequest("readwrite", (objectStore) =>
      objectStore.put(
        {
          handle: this.handle,
          lastSavedAt: this.lastSavedAt,
          lastRevision: this.lastRevision
        },
        this.recordKey
      )
    );
  }

  deleteRecord() {
    return this.runRequest("readwrite", (objectStore) =>
      objectStore.delete(this.recordKey)
    );
  }
}
