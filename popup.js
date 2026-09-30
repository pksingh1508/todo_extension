"use strict";

const BOARDS = {
  todo: {
    name: "Tasks",
    noun: "task",
    placeholder: "Add a task…",
    columns: {
      todo: {
        title: "To Do",
        empty: "No tasks yet",
        hint: "Add one above — press / to jump there."
      },
      progress: {
        title: "In Progress",
        empty: "Nothing in progress",
        hint: "Drag a task here, or hover it and press ▶."
      },
      done: {
        title: "Done",
        empty: "Nothing finished yet",
        hint: "Tick a task to move it here."
      }
    }
  },
  goal: {
    name: "Goals",
    noun: "goal",
    placeholder: "Add a goal…",
    columns: {
      todo: {
        title: "Goals",
        empty: "No goals yet",
        hint: "Add one above — press / to jump there."
      },
      progress: {
        title: "Working On",
        empty: "Nothing in progress",
        hint: "Drag a goal here, or hover it and press ▶."
      },
      done: {
        title: "Achieved",
        empty: "Nothing achieved yet",
        hint: "Tick a goal to celebrate it here."
      }
    }
  }
};

const STATUSES = ["todo", "progress", "done"];
const PREF_KEYS = {
  board: "taskPlannerBoard",
  column: "taskPlannerColumn",
  theme: "taskPlannerTheme",
  dataSeen: "taskPlannerDataSeen"
};
const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const narrowLayout = window.matchMedia("(max-width: 720px)");
const prefersLight = window.matchMedia("(prefers-color-scheme: light)");

// UI preferences only — tasks and goals are kept by SQLiteTaskStore.
const prefs = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (error) {
      // Not being able to remember a preference is harmless.
    }
  }
};

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const escapeHtml = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]
  );

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;top:-1000px;opacity:0";
    document.body.append(area);
    area.select();

    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch (fallbackError) {
      copied = false;
    }
    area.remove();
    return copied;
  }
}

class TaskPlannerApp {
  constructor() {
    this.store = new SQLiteTaskStore();
    this.backup = new FolderBackup(this.store);
    this.root = document.documentElement;
    this.isPopup = this.root.classList.contains("is-popup");
    this.board = this.root.dataset.board === "goal" ? "goal" : "todo";

    const savedColumn = prefs.get(PREF_KEYS.column);
    this.activeColumn = STATUSES.includes(savedColumn) ? savedColumn : "todo";

    this.items = { todo: [], goal: [] };
    this.cards = new Map();
    this.emptyStates = {};
    this.revealIds = new Set();
    this.editing = null;
    this.drag = null;
    this.ready = false;
    this.hasRendered = false;
    this.renderQueued = false;

    this.el = this.queryElements();
    this.cardTemplate = document.getElementById("cardTemplate").content.firstElementChild;
    this.placeholder = document.createElement("div");
    this.placeholder.className = "drop-placeholder";
  }

  queryElements() {
    const byId = (id) => document.getElementById(id);
    const columns = {};
    const lists = {};
    const counts = {};
    const titles = {};
    const tabs = {};

    for (const status of STATUSES) {
      const column = document.querySelector(`.column[data-status="${status}"]`);
      const tab = document.querySelector(`.column-tab[data-status="${status}"]`);
      columns[status] = column;
      lists[status] = column.querySelector(".column-body");
      counts[status] = column.querySelector(".column-count");
      titles[status] = column.querySelector(".column-title");
      tabs[status] = {
        button: tab,
        label: tab.querySelector(".column-tab-label"),
        count: tab.querySelector(".column-tab-count")
      };
    }

    return {
      composer: byId("composer"),
      input: byId("composerInput"),
      board: byId("board"),
      columns,
      lists,
      counts,
      titles,
      tabs,
      columnTabs: byId("columnTabs"),
      boardTabs: [...document.querySelectorAll(".segmented-btn")],
      boardCounts: { todo: byId("countTasks"), goal: byId("countGoals") },
      themeBtn: byId("themeBtn"),
      dataBtn: byId("dataBtn"),
      dataPanel: byId("dataPanel"),
      dataPanelBody: byId("dataPanelBody"),
      openFullBtn: byId("openFullBtn"),
      restoreInput: byId("restoreInput"),
      toasts: byId("toasts"),
      today: byId("today")
    };
  }

  async start() {
    this.renderToday();
    setInterval(() => this.renderToday(), 60_000);
    this.applyBoardChrome();
    this.setActiveColumn(this.activeColumn, { save: false });
    this.updateThemeButton();
    this.bindEvents();

    try {
      await this.store.init();
    } catch (error) {
      console.error("Task Planner could not open its database.", error);
      this.showLoadError(error);
      return;
    }

    this.ready = true;
    this.store.addEventListener("change", () => this.queueRender());
    this.store.addEventListener("persisted", () => this.backup.scheduleSave());
    this.backup.addEventListener("statechange", () => this.renderDataStatus());
    this.refresh();
    this.root.classList.add("is-ready");

    if (this.store.notice) {
      this.toast(this.store.notice, { tone: "error", duration: 12_000 });
    }

    await this.backup.init();
    this.renderDataStatus();

    if (location.hash === "#data") {
      history.replaceState(null, "", location.pathname + location.search);
      this.openDataPanel();
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  queueRender() {
    if (this.renderQueued) return;

    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.refresh();
    });
  }

  refresh() {
    this.items.todo = this.store.getItems("todo");
    this.items.goal = this.store.getItems("goal");
    this.render();
  }

  render() {
    const groups = { todo: [], progress: [], done: [] };
    for (const item of this.items[this.board]) groups[item.status].push(item);

    const animate = this.hasRendered && !reducedMotion.matches;
    const before = animate ? this.measureCards() : null;
    const seen = new Set();

    for (const status of STATUSES) {
      const cards = groups[status].map((item) => {
        seen.add(item.id);
        return this.upsertCard(item, animate);
      });
      this.placeCards(status, cards);
      this.el.counts[status].textContent = cards.length;
      this.el.tabs[status].count.textContent = cards.length;
    }

    for (const [id, card] of this.cards) {
      if (!seen.has(id)) {
        card.remove();
        this.cards.delete(id);
      }
    }

    this.revealCards();
    if (before) this.animateMoves(before);
    if (!this.hasRendered) this.staggerIn();

    for (const type of Object.keys(BOARDS)) {
      const open = this.items[type].filter((item) => item.status !== "done").length;
      this.el.boardCounts[type].textContent = open || "";
    }

    this.root.classList.toggle(
      "is-empty",
      !this.items.todo.length && !this.items.goal.length
    );
    this.hasRendered = true;
    this.renderDataStatus();
  }

  upsertCard(item, isNew) {
    let card = this.cards.get(item.id);
    if (!card) {
      card = this.cardTemplate.cloneNode(true);
      card.dataset.id = item.id;
      this.cards.set(item.id, card);
      if (isNew) this.playEnter(card);
    }

    this.updateCard(card, item);
    return card;
  }

  updateCard(card, item) {
    const columns = BOARDS[this.board].columns;
    card.dataset.status = item.status;

    if (card.taskText !== item.text && this.editing?.id !== item.id) {
      card.taskText = item.text;
      card.querySelector(".card-text").textContent = item.text;
    }

    const done = item.status === "done";
    const check = card.querySelector(".card-check");
    const checkLabel = done
      ? `Move back to ${columns.todo.title}`
      : `Mark as ${columns.done.title.toLowerCase()}`;
    check.setAttribute("aria-pressed", String(done));
    check.setAttribute("aria-label", checkLabel);
    check.title = checkLabel;

    const move = card.querySelector('[data-action="progress"]');
    const inProgress = item.status === "progress";
    const moveLabel = inProgress
      ? `Move back to ${columns.todo.title}`
      : `Start — move to ${columns.progress.title}`;
    move.hidden = done;
    if (move.title !== moveLabel) {
      move.title = moveLabel;
      move.setAttribute("aria-label", moveLabel);
      move.querySelector("use").setAttribute("href", inProgress ? "#i-pause" : "#i-play");
    }
  }

  // Puts `cards` into the column in order, reusing the existing elements so
  // unchanged cards don't flicker.
  placeCards(status, cards) {
    const list = this.el.lists[status];

    cards.forEach((card, index) => {
      const current = list.children[index];
      if (current !== card) list.insertBefore(card, current ?? null);
    });
    while (list.children.length > cards.length) list.lastElementChild.remove();

    if (!cards.length) list.append(this.emptyState(status));
  }

  emptyState(status) {
    let element = this.emptyStates[status];
    if (!element) {
      element = document.createElement("div");
      element.className = "empty-state";
      element.append(document.createElement("strong"), document.createElement("span"));
      if (status === "todo") {
        const restore = document.createElement("button");
        restore.type = "button";
        restore.className = "empty-restore";
        restore.dataset.openData = "";
        restore.textContent = "Restore from a backup";
        element.append(restore);
      }
      this.emptyStates[status] = element;
    }

    const copy = BOARDS[this.board].columns[status];
    element.querySelector("strong").textContent = copy.empty;
    element.querySelector("span").textContent = copy.hint;
    return element;
  }

  playEnter(card, delay = 0) {
    card.style.setProperty("--delay", `${delay}ms`);
    card.classList.add("is-entering");
    const done = (event) => {
      if (event.target !== card) return;
      card.classList.remove("is-entering");
      card.removeEventListener("animationend", done);
    };
    card.addEventListener("animationend", done);
  }

  staggerIn() {
    if (reducedMotion.matches) return;

    for (const status of STATUSES) {
      const cards = this.el.lists[status].querySelectorAll(".card");
      [...cards].slice(0, 30).forEach((card, index) => this.playEnter(card, index * 16));
    }
  }

  // Scrolls newly added or moved cards into view within their column.
  revealCards() {
    for (const id of this.revealIds) {
      const card = this.cards.get(id);
      const list = card?.parentElement;
      if (!list || !card.offsetParent) continue;

      const top = card.offsetTop;
      const bottom = top + card.offsetHeight;
      if (top < list.scrollTop) {
        list.scrollTop = Math.max(0, top - 8);
      } else if (bottom > list.scrollTop + list.clientHeight) {
        list.scrollTop = bottom - list.clientHeight + 8;
      }
    }
    this.revealIds.clear();
  }

  measureCards() {
    const rects = new Map();
    for (const [id, card] of this.cards) {
      if (!card.isConnected) continue;
      const rect = card.getBoundingClientRect();
      if (rect.width) rects.set(id, { rect, status: card.dataset.status });
    }
    return rects;
  }

  // FLIP: cards slide from where they were to where they are now; a card whose
  // status changed flies across to its new column.
  animateMoves(before) {
    for (const [id, card] of this.cards) {
      const previous = before.get(id);
      if (!previous || !card.isConnected) continue;

      const rect = card.getBoundingClientRect();
      if (!rect.width) continue;

      const dx = previous.rect.left - rect.left;
      const dy = previous.rect.top - rect.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;

      if (previous.status !== card.dataset.status) {
        this.flyAcross(card, previous.rect, rect);
      } else {
        card.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
          { duration: 260, easing: EASE_OUT }
        );
      }
    }
  }

  flyAcross(card, from, to) {
    const ghost = card.cloneNode(true);
    ghost.classList.remove("is-entering", "is-landed");
    ghost.classList.add("card-ghost");
    ghost.removeAttribute("draggable");
    ghost.setAttribute("aria-hidden", "true");
    Object.assign(ghost.style, {
      left: `${from.left}px`,
      top: `${from.top}px`,
      width: `${from.width}px`,
      height: `${from.height}px`
    });
    document.body.append(ghost);
    card.classList.add("is-arriving");

    const dx = to.left - from.left;
    const dy = to.top - from.top;
    const flight = ghost.animate(
      [
        { transform: "translate(0, 0) scale(1)" },
        { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 14}px) scale(1.03)`, offset: 0.45 },
        { transform: `translate(${dx}px, ${dy}px) scale(1)` }
      ],
      { duration: 460, easing: EASE_OUT }
    );

    flight.finished
      .catch(() => {})
      .finally(() => {
        ghost.remove();
        card.classList.remove("is-arriving");
        this.flash(card);
      });
  }

  flash(card) {
    card.classList.remove("is-landed");
    void card.offsetWidth;
    card.classList.add("is-landed");
    card.addEventListener("animationend", () => card.classList.remove("is-landed"), {
      once: true
    });
  }

  renderToday() {
    this.el.today.textContent = new Intl.DateTimeFormat(undefined, {
      weekday: "long",
      day: "numeric",
      month: "long"
    }).format(new Date());
  }

  applyBoardChrome() {
    const board = BOARDS[this.board];

    for (const tab of this.el.boardTabs) {
      tab.setAttribute("aria-selected", String(tab.dataset.board === this.board));
    }
    this.el.input.placeholder = board.placeholder;
    this.el.input.setAttribute("aria-label", `Add a ${board.noun}`);

    for (const status of STATUSES) {
      this.el.titles[status].textContent = board.columns[status].title;
      this.el.tabs[status].label.textContent = board.columns[status].title;
      if (this.emptyStates[status]) this.emptyState(status);
    }
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  bindEvents() {
    this.el.composer.addEventListener("submit", (event) => {
      event.preventDefault();
      this.addFromComposer();
    });

    for (const tab of this.el.boardTabs) {
      tab.addEventListener("click", () => this.switchBoard(tab.dataset.board));
    }
    for (const status of STATUSES) {
      this.el.tabs[status].button.addEventListener("click", () =>
        this.setActiveColumn(status)
      );
    }

    this.el.board.addEventListener("click", (event) => this.onBoardClick(event));
    this.el.board.addEventListener("dblclick", (event) => this.onBoardDoubleClick(event));
    this.el.themeBtn.addEventListener("click", () => this.toggleTheme());
    this.el.openFullBtn.addEventListener("click", () => this.openFullBoard());
    this.el.dataPanel.addEventListener("beforetoggle", (event) => {
      if (event.newState === "open") this.onDataPanelOpen();
    });
    this.el.dataPanel.addEventListener("click", (event) => this.onDataPanelClick(event));
    this.el.restoreInput.addEventListener("change", () => this.restoreFromFile());

    document.addEventListener("keydown", (event) => this.onKeyDown(event));
    window.addEventListener("storage", (event) => {
      if (event.key === PREF_KEYS.theme) this.applySavedTheme();
    });
    window.addEventListener("resize", () => {
      if (this.el.dataPanel.matches(":popover-open")) this.positionDataPanel();
    });
    prefersLight.addEventListener("change", () => this.applySavedTheme());

    this.bindDragAndDrop();
  }

  onBoardClick(event) {
    if (event.target.closest("[data-open-data]")) {
      this.openDataPanel();
      return;
    }

    const card = event.target.closest(".card");
    if (!card || card.classList.contains("is-leaving")) return;

    const id = card.dataset.id;
    if (event.target.closest(".card-check")) {
      this.toggleDone(id);
      return;
    }

    const button = event.target.closest("[data-action]");
    switch (button?.dataset.action) {
      case "progress":
        this.toggleProgress(id);
        break;
      case "copy":
        this.copyItem(id, button);
        break;
      case "edit":
        this.startEditing(id);
        break;
      case "delete":
        this.deleteItem(id);
        break;
      default:
        if (!card.classList.contains("is-editing") && event.target.closest(".card-text")) {
          this.toggleExpanded(card);
        }
    }
  }

  onBoardDoubleClick(event) {
    const card = event.target.closest(".card");
    if (!card || event.target.closest("button") || card.classList.contains("is-editing")) {
      return;
    }
    this.startEditing(card.dataset.id);
  }

  onKeyDown(event) {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;

    const typing =
      event.target instanceof Element &&
      event.target.closest("input, textarea, select, [contenteditable='true']");
    if (typing) {
      if (event.key === "Escape" && event.target === this.el.input) this.el.input.blur();
      return;
    }

    if (event.key === "/" || event.key === "n") {
      event.preventDefault();
      this.el.input.focus();
    }
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  findItem(id) {
    return this.items[this.board].find((item) => item.id === id);
  }

  async addFromComposer() {
    const input = this.el.input;
    const text = input.value.trim();
    if (!text) {
      this.nudge(this.el.composer);
      input.focus();
      return;
    }
    if (!this.ready) return;

    const type = this.board;
    const id = this.store.createId();
    input.value = "";
    this.revealIds.add(id);
    if (this.activeColumn !== "todo") this.setActiveColumn("todo");

    try {
      await this.store.addItem(type, text, { id });
    } catch (error) {
      if (!input.value) input.value = text;
      this.reportSaveError(error);
    }
  }

  nudge(element) {
    element.classList.remove("is-invalid");
    void element.offsetWidth;
    element.classList.add("is-invalid");
    element.addEventListener("animationend", () => element.classList.remove("is-invalid"), {
      once: true
    });
  }

  toggleDone(id) {
    const item = this.findItem(id);
    if (item) this.changeStatus(item, item.status === "done" ? "todo" : "done");
  }

  toggleProgress(id) {
    const item = this.findItem(id);
    if (!item || item.status === "done") return;
    this.changeStatus(item, item.status === "progress" ? "todo" : "progress");
  }

  async changeStatus(item, status) {
    const type = this.board;
    this.revealIds.add(item.id);

    try {
      await this.store.setStatus(type, item.id, status);
      if (narrowLayout.matches) {
        this.toast(`Moved to ${BOARDS[type].columns[status].title}`, { key: "moved" });
      }
    } catch (error) {
      this.reportSaveError(error);
    }
  }

  async copyItem(id, button) {
    const item = this.findItem(id);
    if (!item) return;

    if (!(await copyToClipboard(item.text))) {
      this.toast("Couldn't copy to the clipboard.", { tone: "error" });
      return;
    }

    const use = button.querySelector("use");
    use.setAttribute("href", "#i-check");
    button.classList.add("is-copied");
    clearTimeout(button.copyTimer);
    button.copyTimer = setTimeout(() => {
      use.setAttribute("href", "#i-copy");
      button.classList.remove("is-copied");
    }, 1400);
    this.toast("Copied to clipboard", { key: "copied" });
  }

  async deleteItem(id) {
    const type = this.board;
    const card = this.cards.get(id);
    if (this.editing?.id === id) this.finishEditing(false);

    let collapse = null;
    if (card && !reducedMotion.matches) {
      card.classList.add("is-leaving");
      collapse = card.animate(
        [
          { opacity: 1, transform: "scale(1)", height: `${card.offsetHeight}px` },
          {
            opacity: 0,
            transform: "scale(0.96)",
            height: "0px",
            paddingTop: "0px",
            paddingBottom: "0px",
            borderWidth: "0px"
          }
        ],
        { duration: 200, easing: "ease-in", fill: "forwards" }
      );
      await collapse.finished.catch(() => {});
    }

    try {
      const snapshot = await this.store.deleteItem(type, id);
      if (!snapshot) return;

      this.toast(`${capitalize(BOARDS[type].noun)} deleted`, {
        key: "deleted",
        action: "Undo",
        onAction: () => this.undoDelete(type, snapshot)
      });
    } catch (error) {
      collapse?.cancel();
      card?.classList.remove("is-leaving");
      this.reportSaveError(error);
    }
  }

  async undoDelete(type, snapshot) {
    try {
      if (type !== this.board) this.switchBoard(type);
      this.revealIds.add(String(snapshot.row.id));
      await this.store.restoreItem(type, snapshot);
    } catch (error) {
      this.reportSaveError(error);
    }
  }

  toggleExpanded(card) {
    const text = card.querySelector(".card-text");
    if (card.classList.contains("is-expanded") || text.scrollHeight > text.clientHeight + 1) {
      card.classList.toggle("is-expanded");
    }
  }

  startEditing(id) {
    if (this.editing?.id === id) return;
    if (this.editing) this.finishEditing(true);

    const card = this.cards.get(id);
    const item = this.findItem(id);
    if (!card || !item) return;

    const text = card.querySelector(".card-text");
    const editor = document.createElement("textarea");
    editor.className = "card-editor";
    editor.value = item.text;
    editor.rows = 1;
    editor.maxLength = 2000;
    editor.setAttribute("aria-label", `Edit ${BOARDS[this.board].noun}`);

    card.classList.add("is-editing");
    card.draggable = false;
    text.hidden = true;
    text.after(editor);
    this.editing = { id, type: this.board, card, editor, original: item.text };

    const fit = () => {
      editor.style.height = "auto";
      editor.style.height = `${editor.scrollHeight}px`;
    };
    editor.addEventListener("input", fit);
    editor.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.finishEditing(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.finishEditing(false);
      }
    });
    editor.addEventListener("blur", () => this.finishEditing(true));

    fit();
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }

  async finishEditing(save) {
    const editing = this.editing;
    if (!editing) return;
    this.editing = null;

    const { id, type, card, editor, original } = editing;
    const value = editor.value.trim();
    const text = card.querySelector(".card-text");
    editor.remove();
    text.hidden = false;
    card.classList.remove("is-editing");
    card.draggable = true;

    if (!save || value === original) return;
    if (!value) {
      this.toast(`A ${BOARDS[type].noun} can't be empty — your edit was not saved.`);
      return;
    }

    card.taskText = value;
    text.textContent = value;
    try {
      await this.store.updateText(type, id, value);
    } catch (error) {
      card.taskText = original;
      text.textContent = original;
      this.reportSaveError(error);
    }
  }

  switchBoard(type) {
    if (type === this.board || !BOARDS[type]) return;
    if (this.editing) this.finishEditing(true);

    this.board = type;
    this.root.dataset.board = type;
    prefs.set(PREF_KEYS.board, type);
    this.applyBoardChrome();

    for (const card of this.cards.values()) card.remove();
    this.cards.clear();
    this.hasRendered = false;
    if (this.ready) this.render();
  }

  setActiveColumn(status, { save = true } = {}) {
    this.activeColumn = status;
    this.el.board.dataset.column = status;
    this.el.columnTabs.style.setProperty("--index", STATUSES.indexOf(status));
    for (const key of STATUSES) {
      this.el.tabs[key].button.setAttribute("aria-selected", String(key === status));
    }
    if (save) prefs.set(PREF_KEYS.column, status);
  }

  reportSaveError(error) {
    console.error(error);
    this.toast("Couldn't save that change. Your saved data is untouched — please try again.", {
      tone: "error"
    });
  }

  openFullBoard(hash = "") {
    const url = this.store.getRuntimeUrl(`popup.html${hash}`);
    if (typeof chrome !== "undefined" && chrome.tabs?.create) {
      chrome.tabs.create({ url });
    } else {
      window.open(url, "_blank");
    }
    if (this.isPopup) window.close();
  }

  showLoadError(error) {
    this.root.classList.add("is-ready");
    this.el.input.disabled = true;

    const box = document.createElement("div");
    box.className = "load-error";
    box.setAttribute("role", "alert");
    box.innerHTML = `
      <span class="load-error-icon"><svg class="icon" aria-hidden="true"><use href="#i-alert"/></svg></span>
      <h2>Couldn't open your board</h2>
      <p></p>
      <button class="btn btn-primary" type="button">Reload</button>`;
    box.querySelector("p").textContent =
      error?.message || "Something went wrong while opening your saved tasks.";
    box.querySelector("button").addEventListener("click", () => location.reload());
    this.el.board.replaceChildren(box);
  }

  // ---------------------------------------------------------------------------
  // Drag and drop
  // ---------------------------------------------------------------------------

  bindDragAndDrop() {
    this.el.board.addEventListener("dragstart", (event) => this.onDragStart(event));
    this.el.board.addEventListener("dragend", () => this.endDrag());

    for (const status of STATUSES) {
      const column = this.el.columns[status];
      column.addEventListener("dragover", (event) => {
        if (!this.drag) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        this.movePlaceholder(status, event.clientY);
      });
      column.addEventListener("drop", (event) => {
        if (!this.drag) return;
        event.preventDefault();
        this.dropInto(status);
      });

      // In the one-column layout, the tabs accept drops too.
      const tab = this.el.tabs[status].button;
      tab.addEventListener("dragover", (event) => {
        if (!this.drag) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        tab.classList.add("is-drop-target");
      });
      tab.addEventListener("dragleave", () => tab.classList.remove("is-drop-target"));
      tab.addEventListener("drop", (event) => {
        if (!this.drag) return;
        event.preventDefault();
        const item = this.findItem(this.drag.id);
        this.endDrag();
        if (item && item.status !== status) this.changeStatus(item, status);
      });
    }
  }

  onDragStart(event) {
    const card = event.target.closest?.(".card");
    if (!card || card.classList.contains("is-editing") || card.classList.contains("is-leaving")) {
      return;
    }

    this.drag = { id: card.dataset.id, card };
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", card.taskText ?? "");
    this.placeholder.style.height = `${card.offsetHeight}px`;

    // Hide the card on the next frame, after Chrome has taken its drag image.
    requestAnimationFrame(() => {
      if (this.drag?.card !== card) return;
      card.after(this.placeholder);
      card.classList.add("is-dragging");
    });
  }

  movePlaceholder(status, clientY) {
    const list = this.el.lists[status];
    let before = null;

    for (const child of list.children) {
      if (!child.classList.contains("card") || child === this.drag.card) continue;
      const rect = child.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        before = child;
        break;
      }
    }

    if (this.placeholder.parentElement !== list || this.placeholder.nextElementSibling !== before) {
      list.insertBefore(this.placeholder, before);
    }
    this.markDropColumn(status);
  }

  dropInto(status) {
    const { id, card } = this.drag;
    const list = this.el.lists[status];
    const placed = this.placeholder.parentElement === list;

    let next = placed ? this.placeholder.nextElementSibling : null;
    while (next && (!next.classList.contains("card") || next === card)) {
      next = next.nextElementSibling;
    }
    const beforeId = next?.dataset.id ?? null;

    // Show the card where it was dropped right away.
    if (placed) list.insertBefore(card, this.placeholder);
    this.endDrag();

    const item = this.findItem(id);
    if (!item) return;

    if (item.status === status) {
      const column = this.items[this.board].filter((entry) => entry.status === status);
      const index = column.findIndex((entry) => entry.id === id);
      if ((column[index + 1]?.id ?? null) === beforeId) return;
    }

    card.dataset.status = status;
    this.flash(card);
    this.store.moveItem(this.board, id, status, beforeId).catch((error) => {
      this.reportSaveError(error);
      this.queueRender();
    });
  }

  endDrag() {
    if (!this.drag) return;

    this.drag.card.classList.remove("is-dragging");
    this.placeholder.remove();
    this.markDropColumn(null);
    for (const status of STATUSES) {
      this.el.tabs[status].button.classList.remove("is-drop-target");
    }
    this.drag = null;
  }

  markDropColumn(status) {
    for (const key of STATUSES) {
      this.el.columns[key].classList.toggle("is-drop-target", key === status);
    }
  }

  // ---------------------------------------------------------------------------
  // Theme
  // ---------------------------------------------------------------------------

  toggleTheme() {
    const next = this.root.dataset.theme === "dark" ? "light" : "dark";
    prefs.set(PREF_KEYS.theme, next);
    this.applyTheme(next);
  }

  applySavedTheme() {
    const saved = prefs.get(PREF_KEYS.theme);
    const theme =
      saved === "light" || saved === "dark" ? saved : prefersLight.matches ? "light" : "dark";
    this.applyTheme(theme);
  }

  applyTheme(theme) {
    if (this.root.dataset.theme === theme) return;

    this.root.classList.add("theme-transition");
    this.root.dataset.theme = theme;
    this.updateThemeButton();
    clearTimeout(this.themeTimer);
    this.themeTimer = setTimeout(() => this.root.classList.remove("theme-transition"), 400);
  }

  updateThemeButton() {
    const label =
      this.root.dataset.theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
    this.el.themeBtn.title = label;
    this.el.themeBtn.setAttribute("aria-label", label);
  }

  // ---------------------------------------------------------------------------
  // Your data panel
  // ---------------------------------------------------------------------------

  openDataPanel() {
    if (!this.el.dataPanel.matches(":popover-open")) this.el.dataPanel.showPopover();
  }

  onDataPanelOpen() {
    this.positionDataPanel();
    this.renderDataPanel();
    prefs.set(PREF_KEYS.dataSeen, "1");
    this.renderDataStatus();
  }

  positionDataPanel() {
    const rect = this.el.dataBtn.getBoundingClientRect();
    this.el.dataPanel.style.top = `${Math.round(rect.bottom + 8)}px`;
    this.el.dataPanel.style.right = `${Math.max(8, Math.round(window.innerWidth - rect.right))}px`;
  }

  renderDataStatus() {
    const state = this.backup.state;
    const hasItems = this.items.todo.length > 0 || this.items.goal.length > 0;
    let dot = "";
    if (state === "connected") dot = "ok";
    else if (state === "paused" || state === "error") dot = "warn";
    else if (state === "disconnected" && hasItems && !prefs.get(PREF_KEYS.dataSeen)) dot = "nudge";

    const titles = {
      ok: "Your data — backup folder is up to date",
      warn: "Your data — the backup folder needs attention",
      nudge: "Your data — set up a backup folder"
    };
    if (dot) this.el.dataBtn.dataset.dot = dot;
    else delete this.el.dataBtn.dataset.dot;
    this.el.dataBtn.title = titles[dot] ?? "Your data and backups";

    if (this.el.dataPanel.matches(":popover-open")) this.renderDataPanel();
  }

  renderDataPanel() {
    const counts = `${plural(this.items.todo.length, "task")} · ${plural(this.items.goal.length, "goal")}`;
    const saved = this.store.savedAt ? `saved ${this.formatTime(this.store.savedAt)}` : "";
    const storageOk = this.store.health.primary !== "error";
    const where =
      this.store.health.secondary === "ok"
        ? "Kept in Chrome's extension storage, with a second copy in the extension's own files."
        : "Kept in Chrome's extension storage.";

    this.el.dataPanelBody.innerHTML = `
      <section class="panel-section">
        <div class="panel-row">
          <span class="panel-row-icon ${storageOk ? "is-ok" : "is-warn"}">
            <svg class="icon" aria-hidden="true"><use href="#i-${storageOk ? "check" : "alert"}"/></svg>
          </span>
          <div>
            <p class="panel-row-title">${storageOk ? "Saved on this computer" : "The last save failed"}</p>
            <p class="panel-row-sub">${escapeHtml([counts, saved].filter(Boolean).join(" · "))}</p>
          </div>
        </div>
        <p class="panel-note">
          ${where} It stays through restarts, updates and clearing your browsing
          data — nothing is removed unless you delete it.
        </p>
      </section>
      <section class="panel-section">
        <p class="panel-label">Backup folder</p>
        ${this.backupSectionHtml()}
      </section>
      <section class="panel-section">
        <p class="panel-label">Backup file</p>
        <div class="panel-actions">
          <button class="btn btn-soft btn-grow" type="button" data-panel-action="download">
            <svg class="icon" aria-hidden="true"><use href="#i-download"/></svg>Download backup
          </button>
          <button class="btn btn-soft btn-grow" type="button" data-panel-action="restore">
            <svg class="icon" aria-hidden="true"><use href="#i-upload"/></svg>Restore from file…
          </button>
        </div>
        <p class="panel-note">Restoring adds what's missing from the backup — nothing on your board is removed.</p>
      </section>`;
  }

  backupSectionHtml() {
    const backup = this.backup;
    const folder = escapeHtml(backup.folderName);
    const chooseLabel = backup.handle ? "Choose another folder" : "Choose backup folder";
    const choose = `<button class="btn btn-soft" type="button" data-panel-action="choose-folder">
        <svg class="icon" aria-hidden="true"><use href="#i-folder"/></svg>${chooseLabel}</button>`;
    const row = (tone, icon, title, sub) => `
      <div class="panel-row">
        <span class="panel-row-icon ${tone}"><svg class="icon" aria-hidden="true"><use href="#i-${icon}"/></svg></span>
        <div><p class="panel-row-title">${title}</p><p class="panel-row-sub">${sub}</p></div>
      </div>`;

    switch (backup.state) {
      case "connected":
        return `
          ${row("is-ok", "folder", folder, backup.lastSavedAt ? `Up to date · saved ${escapeHtml(this.formatTime(backup.lastSavedAt))}` : "Saving…")}
          <p class="panel-note">Every change is copied to <b>task-planner.sqlite3</b> in this folder, plus a dated copy each day in <b>daily-backups</b>.</p>
          <div class="panel-actions">
            ${choose}
            <button class="btn btn-quiet" type="button" data-panel-action="disconnect">Disconnect</button>
          </div>`;
      case "paused":
        return `
          ${row("is-warn", "alert", "Backups paused", `Chrome needs your OK to keep saving to “${folder}”.`)}
          <div class="panel-actions">
            <button class="btn btn-primary" type="button" data-panel-action="resume">Resume backups</button>
            ${choose}
          </div>`;
      case "error":
        return `
          ${row("is-warn", "alert", `Couldn't save to “${folder}”`, "The folder may have been moved, renamed or deleted.")}
          <div class="panel-actions">
            <button class="btn btn-primary" type="button" data-panel-action="save-now">Try again</button>
            ${choose}
          </div>`;
      case "unsupported":
        return `<p class="panel-note">This browser doesn't let extensions save to a folder. Use <b>Download backup</b> below to keep a copy on your computer.</p>`;
      default:
        return `
          <p class="panel-note">
            Removing the extension also removes Chrome's copy. Pick a folder (like
            Documents) to keep a live copy on your computer — connect the same folder
            after reinstalling and everything comes back.
          </p>
          <div class="panel-actions">${choose}</div>`;
    }
  }

  onDataPanelClick(event) {
    const action = event.target.closest("[data-panel-action]")?.dataset.panelAction;
    if (!action) return;

    // File and folder pickers close the toolbar popup, so do these in a tab.
    if (this.isPopup && ["choose-folder", "resume", "restore"].includes(action)) {
      this.openFullBoard("#data");
      return;
    }

    switch (action) {
      case "choose-folder":
        this.chooseBackupFolder();
        break;
      case "resume":
        this.resumeBackup();
        break;
      case "save-now":
        this.backup.saveNow().then((ok) => {
          if (ok) this.toast("Backup saved");
        });
        break;
      case "disconnect":
        this.disconnectBackup();
        break;
      case "download":
        this.downloadBackup();
        break;
      case "restore":
        this.el.restoreInput.click();
        break;
    }
  }

  async chooseBackupFolder() {
    let handle;
    try {
      handle = await this.backup.pickFolder();
    } catch (error) {
      if (error.name !== "AbortError") {
        this.toast("Couldn't open that folder.", { tone: "error" });
      }
      return;
    }

    let result = null;
    try {
      const existing = await this.backup.readBackupFrom(handle);
      if (existing) {
        const { items } = this.store.readItemsFromBytes(existing.bytes);
        result = await this.store.mergeItems(items);
      }
    } catch (error) {
      console.warn(error);
      this.toast(
        `“${handle.name}” has a task-planner.sqlite3 file that couldn't be read, so it was left untouched. Choose another folder.`,
        { tone: "error", duration: 8000 }
      );
      return;
    }

    const saved = await this.backup.connect(handle);
    if (result && (result.added || result.updated)) {
      this.toast(`${this.describeMerge(result)} Backups now go to “${handle.name}”.`, {
        duration: 6000
      });
    } else if (saved) {
      this.toast(`Backups now go to “${handle.name}”`);
    } else {
      this.toast(`Couldn't save to “${handle.name}” yet — see Your data.`, { tone: "error" });
    }
  }

  async resumeBackup() {
    try {
      const ok = await this.backup.resume();
      this.toast(ok ? "Backups resumed" : "Chrome didn't allow access to the folder.", {
        tone: ok ? "info" : "error"
      });
    } catch (error) {
      this.toast("Couldn't resume backups. Try choosing the folder again.", { tone: "error" });
    }
  }

  async disconnectBackup() {
    await this.backup.disconnect();
    this.toast("Backup folder disconnected. Files already saved there were kept.");
  }

  downloadBackup() {
    const data = this.store.exportData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `task-planner-backup-${this.backup.localDateStamp()}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    this.toast("Backup downloaded");
  }

  async restoreFromFile() {
    const file = this.el.restoreInput.files?.[0];
    this.el.restoreInput.value = "";
    if (!file) return;

    let items;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      items = SQLiteTaskStore.isSQLite(bytes)
        ? this.store.readItemsFromBytes(bytes).items
        : this.store.itemsFromData(JSON.parse(new TextDecoder().decode(bytes)));
    } catch (error) {
      this.toast("That file isn't a Task Planner backup.", { tone: "error" });
      return;
    }

    if (!items.length) {
      this.toast("No tasks or goals were found in that file.");
      return;
    }

    try {
      this.toast(this.describeMerge(await this.store.mergeItems(items)), { duration: 5000 });
    } catch (error) {
      this.reportSaveError(error);
    }
  }

  describeMerge({ added, updated }) {
    const parts = [];
    if (added) parts.push(`added ${plural(added, "item")}`);
    if (updated) parts.push(`updated ${plural(updated, "item")}`);
    return parts.length
      ? `${capitalize(parts.join(" and "))} from the backup.`
      : "Everything in that backup is already on your board.";
  }

  formatTime(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";

    const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);

    if (date.toDateString() === today.toDateString()) return `at ${time}`;
    if (date.toDateString() === yesterday.toDateString()) return `yesterday at ${time}`;
    return `on ${new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(date)} at ${time}`;
  }

  // ---------------------------------------------------------------------------
  // Toasts
  // ---------------------------------------------------------------------------

  toast(message, { tone = "info", action, onAction, duration, key } = {}) {
    if (key) this.el.toasts.querySelector(`[data-key="${key}"]`)?.remove();

    const toast = document.createElement("div");
    toast.className = `toast${tone === "error" ? " is-error" : ""}${action ? " has-action" : ""}`;
    toast.setAttribute("role", tone === "error" ? "alert" : "status");
    if (key) toast.dataset.key = key;

    const text = document.createElement("span");
    text.textContent = message;
    toast.append(text);

    let timer = null;
    const dismiss = () => {
      if (toast.classList.contains("is-leaving")) return;
      clearTimeout(timer);
      toast.classList.add("is-leaving");
      setTimeout(() => toast.remove(), 200);
    };

    if (action) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "toast-action";
      button.textContent = action;
      button.addEventListener("click", () => {
        dismiss();
        onAction?.();
      });
      toast.append(button);
    }

    this.el.toasts.append(toast);
    while (this.el.toasts.children.length > 3) this.el.toasts.firstElementChild.remove();

    const wait = duration ?? (action || tone === "error" ? 6000 : 2200);
    timer = setTimeout(dismiss, wait);
    toast.addEventListener("mouseenter", () => clearTimeout(timer));
    toast.addEventListener("mouseleave", () => {
      timer = setTimeout(dismiss, 1500);
    });
  }
}

document.addEventListener("DOMContentLoaded", () => {
  window.app = new TaskPlannerApp();
  window.app.start();
});
