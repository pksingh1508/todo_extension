class TodoApp {
  constructor() {
    this.todos = [];
    this.goals = [];
    this.draggedItem = null;
    this.draggedId = null;
    this.isGoalsView = false;
    this.draggedType = null; // 'todo' or 'goal'
    this.editingTodoId = null;
    this.editingGoalId = null;
    this.init();
  }

  init() {
    this.loadTodos();
    this.loadGoals();
    this.bindEvents();
  }

  loadTodos() {
    try {
      chrome.storage.local.get(["newTabTodos"], (result) => {
        this.todos = result.newTabTodos || [];
        this.render();
      });
    } catch (error) {
      console.error("Error loading todos:", error);
      this.todos = [];
    }
  }

  saveTodos() {
    try {
      chrome.storage.local.set({ newTabTodos: this.todos });
    } catch (error) {
      console.error("Error saving todos:", error);
    }
  }

  loadGoals() {
    try {
      chrome.storage.local.get(["newTabGoals"], (result) => {
        this.goals = result.newTabGoals || [];
        if (this.isGoalsView) {
          this.renderGoals();
        }
      });
    } catch (error) {
      console.error("Error loading goals:", error);
      this.goals = [];
    }
  }

  saveGoals() {
    try {
      chrome.storage.local.set({ newTabGoals: this.goals });
    } catch (error) {
      console.error("Error saving goals:", error);
    }
  }

  bindEvents() {
    const addBtn = document.getElementById("addBtn");
    const todoInput = document.getElementById("todoInput");

    addBtn.addEventListener("click", () => this.addTodo());
    todoInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        this.addTodo();
      }
    });

    // Goals button toggle
    const goalsBtn = document.getElementById("goalsBtn");
    goalsBtn.addEventListener("click", () => this.toggleGoalsView());

    // Back to todos button
    const backToTodosBtn = document.getElementById("backToTodosBtn");
    backToTodosBtn.addEventListener("click", () => this.toggleGoalsView());

    // Goals input events
    const addGoalBtn = document.getElementById("addGoalBtn");
    const goalInput = document.getElementById("goalInput");

    addGoalBtn.addEventListener("click", () => this.addGoal());
    goalInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        this.addGoal();
      }
    });

    // Listen for changes from other tabs/windows
    try {
      chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === "local" && changes.newTabTodos) {
          this.todos = changes.newTabTodos.newValue || [];
          if (!this.isGoalsView) {
            this.render();
          }
        }
        if (namespace === "local" && changes.newTabGoals) {
          this.goals = changes.newTabGoals.newValue || [];
          if (this.isGoalsView) {
            this.renderGoals();
          }
        }
      });
    } catch (error) {
      console.log("Storage sync not available (running outside Chrome)");
    }
  }

  toggleGoalsView() {
    const mainView = document.getElementById("mainView");
    const goalsView = document.getElementById("goalsView");
    const todoInputSection = document.getElementById("todoInputSection");
    const goalInputSection = document.getElementById("goalInputSection");

    if (!this.isGoalsView) {
      // Switching to Goals view
      this.renderGoals();

      // Animate out todo view
      mainView.style.transform = "translateX(-100%)";
      mainView.style.opacity = "0";

      // Show and animate in goals view
      goalsView.classList.remove("hidden");
      // Force reflow
      void goalsView.offsetWidth;
      goalsView.style.transform = "translateX(0)";
      goalsView.style.opacity = "1";

      // Switch input sections
      todoInputSection.classList.add("hidden");
      goalInputSection.classList.remove("hidden");

      // Hide todo view after animation
      setTimeout(() => {
        mainView.classList.add("hidden");
      }, 400);

      this.isGoalsView = true;
    } else {
      // Switching back to Todo view
      this.render();

      // Animate out goals view
      goalsView.style.transform = "translateX(100%)";
      goalsView.style.opacity = "0";

      // Show and animate in todo view
      mainView.classList.remove("hidden");
      // Force reflow
      void mainView.offsetWidth;
      mainView.style.transform = "translateX(0)";
      mainView.style.opacity = "1";

      // Switch input sections
      goalInputSection.classList.add("hidden");
      todoInputSection.classList.remove("hidden");

      // Hide goals view after animation
      setTimeout(() => {
        goalsView.classList.add("hidden");
      }, 400);

      this.isGoalsView = false;
    }
  }

  addGoal() {
    const input = document.getElementById("goalInput");
    const text = input.value.trim();

    if (!text) {
      this.showGoalInputError();
      return;
    }

    if (this.editingGoalId !== null) {
      this.updateGoal(this.editingGoalId, text);
      return;
    }

    const goal = {
      id: Date.now() + Math.random(),
      text: text,
      completed: false,
      inProgress: false,
      createdAt: new Date().toISOString()
    };

    // Add new goal at the beginning of the array (top of the list)
    this.goals.unshift(goal);
    this.saveGoals();
    this.renderGoals();

    // Clear input and add animation
    input.value = "";
    this.animateGoalInputSuccess();
  }

  updateGoal(id, text) {
    const goal = this.goals.find((g) => g.id === id);
    if (!goal) {
      this.resetGoalEditing();
      return;
    }

    goal.text = text;
    this.saveGoals();
    this.renderGoals();
    this.resetGoalEditing();
    this.animateGoalInputSuccess();
  }

  startEditingGoal(id) {
    const goal = this.goals.find((g) => g.id === id && !g.completed);
    if (!goal) return;

    const input = document.getElementById("goalInput");
    const addGoalBtn = document.getElementById("addGoalBtn");

    this.editingGoalId = id;
    input.value = goal.text;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    addGoalBtn.title = "Save goal";
  }

  resetGoalEditing() {
    const input = document.getElementById("goalInput");
    const addGoalBtn = document.getElementById("addGoalBtn");

    this.editingGoalId = null;
    input.value = "";
    addGoalBtn.title = "";
  }

  toggleGoal(id) {
    const goal = this.goals.find((g) => g.id === id);
    if (goal) {
      goal.completed = !goal.completed;
      // Reset inProgress when completing a goal
      if (goal.completed) {
        goal.inProgress = false;
        if (this.editingGoalId === id) {
          this.resetGoalEditing();
        }
      }
      this.saveGoals();
      this.renderGoals();
    }
  }

  toggleGoalInProgress(id) {
    const goal = this.goals.find((g) => g.id === id);
    if (goal && !goal.completed) {
      goal.inProgress = !goal.inProgress;
      this.saveGoals();
      this.renderGoals();
    }
  }

  deleteGoal(id) {
    this.goals = this.goals.filter((g) => g.id !== id);
    if (this.editingGoalId === id) {
      this.resetGoalEditing();
    }
    this.saveGoals();
    this.renderGoals();
  }

  renderGoals() {
    const activeGoalsContainer = document.getElementById("activeGoals");
    const completedGoalsContainer = document.getElementById("completedGoals");

    // Clear containers
    activeGoalsContainer.innerHTML = "";
    completedGoalsContainer.innerHTML = "";

    // Filter goals
    const activeGoals = this.goals.filter((goal) => !goal.completed);
    const completedGoals = this.goals.filter((goal) => goal.completed);

    // Render active goals
    activeGoals.forEach((goal) => {
      activeGoalsContainer.appendChild(this.createGoalElement(goal));
    });

    // Render completed goals
    completedGoals.forEach((goal) => {
      completedGoalsContainer.appendChild(this.createGoalElement(goal));
    });

    // Update empty states
    this.updateGoalEmptyStates(activeGoalsContainer, completedGoalsContainer);

    // Setup container drag events for active goals
    this.setupGoalsContainerDragEvents(activeGoalsContainer);
  }

  updateGoalEmptyStates(activeContainer, completedContainer) {
    // Remove existing empty messages
    const existingEmptyMessages =
      activeContainer.querySelectorAll(".empty-message");
    existingEmptyMessages.forEach((msg) => msg.remove());
    const existingEmptyMessagesCompleted =
      completedContainer.querySelectorAll(".empty-message");
    existingEmptyMessagesCompleted.forEach((msg) => msg.remove());

    // Add empty state messages if needed
    if (activeContainer.children.length === 0) {
      const emptyMessage = document.createElement("div");
      emptyMessage.className = "empty-message";
      emptyMessage.innerHTML =
        '<p style="text-align: center; color: #888; font-style: italic; padding: 20px;">No active goals</p>';
      emptyMessage.style.animation = "fadeIn 0.5s ease-out";
      activeContainer.appendChild(emptyMessage);
    }

    if (completedContainer.children.length === 0) {
      const emptyMessage = document.createElement("div");
      emptyMessage.className = "empty-message";
      emptyMessage.innerHTML =
        '<p style="text-align: center; color: #888; font-style: italic; padding: 20px;">No completed goals</p>';
      emptyMessage.style.animation = "fadeIn 0.5s ease-out";
      completedContainer.appendChild(emptyMessage);
    }
  }

  createGoalElement(goal) {
    const goalItem = document.createElement("div");
    goalItem.className = `goal-item ${goal.completed ? "completed" : ""}`;
    goalItem.setAttribute("data-id", goal.id);

    // Add drag handle only for active (non-completed) goals
    const dragHandleHtml = !goal.completed
      ? `<div class="drag-handle" title="Drag to reorder">⋮⋮</div>`
      : "";

    // Add progress checkbox only for active (non-completed) goals
    const progressCheckboxHtml = !goal.completed
      ? `<div class="progress-checkbox ${goal.inProgress ? "checked" : ""}" title="Mark as in progress"></div>`
      : "";

    // Add in-progress label above the side controls
    const inProgressLabelHtml = (!goal.completed && goal.inProgress)
      ? `<div class="in-progress-label">Working on Goal...</div>`
      : "";

    // Keep the drag handle separate from the stacked side controls
    const leftControlsHtml = !goal.completed
      ? `<div class="left-controls drag-only">
            ${dragHandleHtml}
          </div>`
      : `<div class="left-controls completed">
          <div class="checkbox ${goal.completed ? "checked" : ""}" title="Mark as completed"></div>
        </div>`;

    const mainContentHtml = !goal.completed
      ? `<div class="item-main-content">
            <div class="item-top-controls">
              ${inProgressLabelHtml}
              <div class="checkbox-row">
                <div class="checkbox ${goal.completed ? "checked" : ""}" title="Mark as completed"></div>
                ${progressCheckboxHtml}
              </div>
            </div>
            <div class="goal-text ${goal.completed ? "completed" : ""} ${goal.inProgress ? "in-progress" : ""}">${this.escapeHtml(goal.text)}</div>
          </div>`
      : `<div class="goal-text ${goal.completed ? "completed" : ""} ${goal.inProgress ? "in-progress" : ""}">${this.escapeHtml(goal.text)}</div>`;

    const sideControlsHtml = !goal.completed
      ? `<div class="goal-actions">
            <button class="delete-btn" title="Delete goal">×</button>
            <button class="edit-btn" title="Edit goal" aria-label="Edit goal">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 20h9"/>
                <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z"/>
              </svg>
            </button>
          </div>`
      : `<button class="delete-btn" title="Delete goal">×</button>`;

    goalItem.innerHTML = `
      ${leftControlsHtml}
      ${mainContentHtml}
      ${sideControlsHtml}
    `;

    // Attach event listeners
    const checkbox = goalItem.querySelector(".checkbox");
    if (checkbox) {
      checkbox.addEventListener("click", () => this.toggleGoal(goal.id));
    }

    // Attach progress checkbox event listener for active goals
    const progressCheckbox = goalItem.querySelector(".progress-checkbox");
    if (progressCheckbox) {
      progressCheckbox.addEventListener("click", (e) => {
        e.stopPropagation();
        this.toggleGoalInProgress(goal.id);
      });
    }

    const deleteBtn = goalItem.querySelector(".delete-btn");
    deleteBtn.addEventListener("click", () => this.deleteGoal(goal.id));

    const editBtn = goalItem.querySelector(".edit-btn");
    if (editBtn) {
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.startEditingGoal(goal.id);
      });
    }

    // Make active goals draggable
    if (!goal.completed) {
      this.makeGoalDraggable(goalItem, goal.id);
    }

    return goalItem;
  }

  makeGoalDraggable(element, id) {
    element.setAttribute("draggable", "true");

    element.addEventListener("dragstart", (e) => {
      this.draggedItem = element;
      this.draggedId = id;
      this.draggedType = "goal";
      element.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", id.toString());
      e.dataTransfer.setData("application/type", "goal");
    });

    element.addEventListener("dragend", (e) => {
      e.stopPropagation();
      element.classList.remove("dragging");
      this.draggedItem = null;
      this.draggedId = null;
      this.draggedType = null;
      document.querySelectorAll(".goal-item").forEach((item) => {
        item.classList.remove("drag-over");
      });
    });

    element.addEventListener("dragenter", (e) => {
      e.preventDefault();
      if (
        this.draggedItem &&
        this.draggedItem !== element &&
        this.draggedType === "goal"
      ) {
        element.classList.add("drag-over");
      }
    });

    element.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";

      if (
        this.draggedItem &&
        this.draggedItem !== element &&
        this.draggedType === "goal"
      ) {
        element.classList.add("drag-over");
      }
    });

    element.addEventListener("dragleave", (e) => {
      if (!element.contains(e.relatedTarget)) {
        element.classList.remove("drag-over");
      }
    });

    element.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      element.classList.remove("drag-over");

      if (
        this.draggedItem &&
        this.draggedItem !== element &&
        this.draggedType === "goal"
      ) {
        this.reorderGoals(this.draggedId, id);
      }
    });
  }

  reorderGoals(draggedId, targetId) {
    const draggedIndex = this.goals.findIndex((g) => g.id === draggedId);
    const targetIndex = this.goals.findIndex((g) => g.id === targetId);

    if (draggedIndex === -1 || targetIndex === -1) return;

    // Remove dragged item and insert at target position
    const [draggedGoal] = this.goals.splice(draggedIndex, 1);
    this.goals.splice(targetIndex, 0, draggedGoal);

    this.saveGoals();
    this.renderGoals();
  }

  setupGoalsContainerDragEvents(container) {
    container.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });

    container.addEventListener("dragenter", (e) => {
      e.preventDefault();
    });

    container.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (
        e.target === container ||
        e.target.classList.contains("empty-message")
      ) {
        if (this.draggedId && this.draggedType === "goal") {
          const draggedIndex = this.goals.findIndex(
            (g) => g.id === this.draggedId
          );
          if (draggedIndex !== -1 && draggedIndex !== this.goals.length - 1) {
            const [draggedGoal] = this.goals.splice(draggedIndex, 1);
            this.goals.push(draggedGoal);
            this.saveGoals();
            this.renderGoals();
          }
        }
      }
    });
  }

  showGoalInputError() {
    const input = document.getElementById("goalInput");
    const originalPlaceholder = input.placeholder;

    input.style.borderColor = "#ff6a81";
    input.placeholder = "Please enter a goal!";

    setTimeout(() => {
      input.style.borderColor = "rgba(157, 78, 221, 0.35)";
      input.placeholder = originalPlaceholder;
    }, 2000);

    input.style.animation = "shake 0.5s ease-in-out";
    setTimeout(() => {
      input.style.animation = "";
    }, 500);
  }

  animateGoalInputSuccess() {
    const input = document.getElementById("goalInput");
    input.style.background = "rgba(199, 125, 255, 0.18)";
    setTimeout(() => {
      input.style.background = "rgba(13, 18, 38, 0.9)";
    }, 300);
  }

  addTodo() {
    const input = document.getElementById("todoInput");
    const text = input.value.trim();

    if (!text) {
      this.showInputError();
      return;
    }

    if (this.editingTodoId !== null) {
      this.updateTodo(this.editingTodoId, text);
      return;
    }

    const todo = {
      id: Date.now() + Math.random(),
      text: text,
      completed: false,
      inProgress: false,
      createdAt: new Date().toISOString()
    };

    // Add new todo at the beginning of the array (top of the list)
    this.todos.unshift(todo);
    this.saveTodos();
    this.render();

    // Clear input and add animation
    input.value = "";
    this.animateInputSuccess();
  }

  updateTodo(id, text) {
    const todo = this.todos.find((t) => t.id === id);
    if (!todo) {
      this.resetTodoEditing();
      return;
    }

    todo.text = text;
    this.saveTodos();
    this.render();
    this.resetTodoEditing();
    this.animateInputSuccess();
  }

  startEditingTodo(id) {
    const todo = this.todos.find((t) => t.id === id && !t.completed);
    if (!todo) return;

    const input = document.getElementById("todoInput");
    const addBtn = document.getElementById("addBtn");

    this.editingTodoId = id;
    input.value = todo.text;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    addBtn.title = "Save task";
  }

  resetTodoEditing() {
    const input = document.getElementById("todoInput");
    const addBtn = document.getElementById("addBtn");

    this.editingTodoId = null;
    input.value = "";
    addBtn.title = "";
  }

  toggleTodo(id) {
    const todo = this.todos.find((t) => t.id === id);
    if (todo) {
      todo.completed = !todo.completed;
      // Reset inProgress when completing a task
      if (todo.completed) {
        todo.inProgress = false;
        if (this.editingTodoId === id) {
          this.resetTodoEditing();
        }
      }
      this.saveTodos();
      this.render();

      // Add animation for completed todos
      if (todo.completed) {
        this.animateTodoComplete();
      }
    }
  }

  toggleInProgress(id) {
    const todo = this.todos.find((t) => t.id === id);
    if (todo && !todo.completed) {
      todo.inProgress = !todo.inProgress;
      this.saveTodos();
      this.render();
    }
  }

  deleteTodo(id) {
    this.todos = this.todos.filter((t) => t.id !== id);
    if (this.editingTodoId === id) {
      this.resetTodoEditing();
    }
    this.saveTodos();
    this.render();
    this.animateTodoDelete();
  }

  render() {
    const activeTodosContainer = document.getElementById("activeTodos");
    const completedTodosContainer = document.getElementById("completedTodos");

    // Clear containers
    activeTodosContainer.innerHTML = "";
    completedTodosContainer.innerHTML = "";

    // Filter todos - maintain array order for active todos (to preserve drag reordering)
    const activeTodos = this.todos.filter((todo) => !todo.completed);
    const completedTodos = this.todos.filter((todo) => todo.completed);

    // Only sort completed todos by creation date (oldest first)
    // Active todos maintain their manual order from drag-and-drop
    completedTodos.sort(
      (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
    );

    // Render active todos
    activeTodos.forEach((todo) => {
      activeTodosContainer.appendChild(this.createTodoElement(todo));
    });

    // Render completed todos
    completedTodos.forEach((todo) => {
      completedTodosContainer.appendChild(this.createTodoElement(todo));
    });

    // Update empty state messages
    this.updateEmptyStates(activeTodosContainer, completedTodosContainer);

    // Add container-level drag events for active todos
    this.setupContainerDragEvents(activeTodosContainer);
  }

  setupContainerDragEvents(container) {
    container.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });

    container.addEventListener("dragenter", (e) => {
      e.preventDefault();
    });

    container.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();

      // If dropped on empty space in container, move to end
      if (
        e.target === container ||
        e.target.classList.contains("empty-message")
      ) {
        if (this.draggedId && this.draggedType === "todo") {
          const activeTodos = this.todos.filter((todo) => !todo.completed);
          const lastActiveTodo = activeTodos[activeTodos.length - 1];
          if (lastActiveTodo && lastActiveTodo.id !== this.draggedId) {
            // Move to end by reordering with last item
            this.moveTodoToEnd(this.draggedId);
          }
        }
      }
    });
  }

  moveTodoToEnd(draggedId) {
    // Get only active todos
    const activeTodos = this.todos.filter((todo) => !todo.completed);
    const completedTodos = this.todos.filter((todo) => todo.completed);

    // Find the dragged todo
    const draggedIndex = activeTodos.findIndex((t) => t.id === draggedId);
    if (draggedIndex === -1) return;

    // Remove dragged item and add to end
    const [draggedTodo] = activeTodos.splice(draggedIndex, 1);
    activeTodos.push(draggedTodo);

    // Reconstruct todos array
    this.todos = [...activeTodos, ...completedTodos];

    this.saveTodos();
    this.render();
  }

  createTodoElement(todo) {
    const todoItem = document.createElement("div");
    todoItem.className = `todo-item ${todo.completed ? "completed" : ""}`;
    todoItem.setAttribute("data-id", todo.id);

    // Add drag handle only for active (non-completed) todos
    const dragHandleHtml = !todo.completed
      ? `<div class="drag-handle" title="Drag to reorder">⋮⋮</div>`
      : "";

    // Add progress checkbox only for active (non-completed) todos
    const progressCheckboxHtml = !todo.completed
      ? `<div class="progress-checkbox ${todo.inProgress ? "checked" : ""}" title="Mark as in progress"></div>`
      : "";

    // Add in-progress label above the side controls
    const inProgressLabelHtml = (!todo.completed && todo.inProgress)
      ? `<div class="in-progress-label">Working on Task...</div>`
      : "";

    // Keep the drag handle separate from the stacked side controls
    const leftControlsHtml = !todo.completed
      ? `<div class="left-controls drag-only">
            ${dragHandleHtml}
          </div>`
      : `<div class="left-controls completed">
          <div class="checkbox ${todo.completed ? "checked" : ""}" title="Mark as completed"></div>
        </div>`;

    const mainContentHtml = !todo.completed
      ? `<div class="item-main-content">
            <div class="item-top-controls">
              ${inProgressLabelHtml}
              <div class="checkbox-row">
                <div class="checkbox ${todo.completed ? "checked" : ""}" title="Mark as completed"></div>
                ${progressCheckboxHtml}
              </div>
            </div>
            <div class="todo-text ${
              todo.completed ? "completed" : ""
            } ${todo.inProgress ? "in-progress" : ""}">${this.escapeHtml(todo.text)}</div>
          </div>`
      : `<div class="todo-text ${
          todo.completed ? "completed" : ""
        } ${todo.inProgress ? "in-progress" : ""}">${this.escapeHtml(todo.text)}</div>`;

    const sideControlsHtml = !todo.completed
      ? `<div class="todo-actions">
            <button class="delete-btn" title="Delete todo">×</button>
            <button class="edit-btn" title="Edit todo" aria-label="Edit todo">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 20h9"/>
                <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z"/>
              </svg>
            </button>
          </div>`
      : `<button class="delete-btn" title="Delete todo">×</button>`;

    todoItem.innerHTML = `
            ${leftControlsHtml}
            ${mainContentHtml}
            ${sideControlsHtml}
        `;

    const deleteButton = todoItem.querySelector(".delete-btn");
    deleteButton.innerHTML = "&times;";

    // Attach event listeners
    const checkbox = todoItem.querySelector(".checkbox");
    if (checkbox) {
      checkbox.addEventListener("click", () => this.toggleTodo(todo.id));
    }

    // Attach progress checkbox event listener for active todos
    const progressCheckbox = todoItem.querySelector(".progress-checkbox");
    if (progressCheckbox) {
      progressCheckbox.addEventListener("click", (e) => {
        e.stopPropagation();
        this.toggleInProgress(todo.id);
      });
    }

    const deleteBtn = todoItem.querySelector(".delete-btn");
    deleteBtn.addEventListener("click", () => this.deleteTodo(todo.id));

    const editBtn = todoItem.querySelector(".edit-btn");
    if (editBtn) {
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.startEditingTodo(todo.id);
      });
    }

    // Make active todos draggable
    if (!todo.completed) {
      this.makeDraggable(todoItem, todo.id);
    }

    return todoItem;
  }

  makeDraggable(element, id) {
    element.setAttribute("draggable", "true");

    element.addEventListener("dragstart", (e) => {
      this.draggedItem = element;
      this.draggedId = id;
      this.draggedType = "todo";
      element.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", id.toString());
      // Prevent text selection during drag
      e.dataTransfer.setData("application/todo-id", id.toString());
    });

    element.addEventListener("dragend", (e) => {
      e.stopPropagation();
      element.classList.remove("dragging");
      this.draggedItem = null;
      this.draggedId = null;
      this.draggedType = null;
      // Remove all drag-over classes
      document.querySelectorAll(".todo-item").forEach((item) => {
        item.classList.remove("drag-over");
      });
    });

    element.addEventListener("dragenter", (e) => {
      e.preventDefault();
      if (
        this.draggedItem &&
        this.draggedItem !== element &&
        this.draggedType === "todo"
      ) {
        element.classList.add("drag-over");
      }
    });

    element.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";

      if (
        this.draggedItem &&
        this.draggedItem !== element &&
        this.draggedType === "todo"
      ) {
        element.classList.add("drag-over");
      }
    });

    element.addEventListener("dragleave", (e) => {
      // Only remove if we're actually leaving the element (not entering a child)
      if (!element.contains(e.relatedTarget)) {
        element.classList.remove("drag-over");
      }
    });

    element.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      element.classList.remove("drag-over");

      if (
        this.draggedItem &&
        this.draggedItem !== element &&
        this.draggedType === "todo"
      ) {
        this.reorderTodos(this.draggedId, id);
      }
    });
  }

  reorderTodos(draggedId, targetId) {
    // Get only active todos
    const activeTodos = this.todos.filter((todo) => !todo.completed);
    const completedTodos = this.todos.filter((todo) => todo.completed);

    // Find indices in active todos array
    const draggedIndex = activeTodos.findIndex((t) => t.id === draggedId);
    const targetIndex = activeTodos.findIndex((t) => t.id === targetId);

    if (draggedIndex === -1 || targetIndex === -1) return;

    // Remove dragged item and insert at target position
    const [draggedTodo] = activeTodos.splice(draggedIndex, 1);
    activeTodos.splice(targetIndex, 0, draggedTodo);

    // Reconstruct todos array: active todos in new order + completed todos
    this.todos = [...activeTodos, ...completedTodos];

    this.saveTodos();
    this.render();
  }

  updateEmptyStates(activeContainer, completedContainer) {
    // Remove existing empty messages
    const existingEmptyMessages = document.querySelectorAll(".empty-message");
    existingEmptyMessages.forEach((msg) => msg.remove());

    // Add empty state messages if needed
    if (activeContainer.children.length === 0) {
      const emptyMessage = document.createElement("div");
      emptyMessage.className = "empty-message";
      emptyMessage.innerHTML =
        '<p style="text-align: center; color: #888; font-style: italic; padding: 20px;">No active tasks</p>';
      emptyMessage.style.animation = "fadeIn 0.5s ease-out";
      activeContainer.appendChild(emptyMessage);
    }

    if (completedContainer.children.length === 0) {
      const emptyMessage = document.createElement("div");
      emptyMessage.className = "empty-message";
      emptyMessage.innerHTML =
        '<p style="text-align: center; color: #888; font-style: italic; padding: 20px;">No completed tasks</p>';
      emptyMessage.style.animation = "fadeIn 0.5s ease-out";
      completedContainer.appendChild(emptyMessage);
    }
  }

  escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  showInputError() {
    const input = document.getElementById("todoInput");
    const originalPlaceholder = input.placeholder;
    const resetBorderColor = "rgba(92, 116, 228, 0.35)";

    input.style.borderColor = "#ff6a81";
    input.placeholder = "Please enter a todo!";

    setTimeout(() => {
      input.style.borderColor = resetBorderColor;
      input.placeholder = originalPlaceholder;
    }, 2000);

    // Shake animation
    input.style.animation = "shake 0.5s ease-in-out";
    setTimeout(() => {
      input.style.animation = "";
    }, 500);
  }

  animateInputSuccess() {
    const input = document.getElementById("todoInput");
    input.style.background = "rgba(50, 213, 255, 0.18)";
    setTimeout(() => {
      input.style.background = "rgba(13, 18, 38, 0.9)";
    }, 300);
  }

  animateTodoComplete() {
    // Add a visual effect when todo is completed
    const activeTodos = document.getElementById("activeTodos");
    activeTodos.style.transform = "scale(0.98)";
    setTimeout(() => {
      activeTodos.style.transform = "scale(1)";
    }, 150);
  }

  animateTodoDelete() {
    // Add fade out animation for deleted todo
    document.body.style.background =
      "radial-gradient(circle at 20% 20%, #101a3a 0%, #070b1d 45%, #040713 100%)";
  }
}

// Initialize the app when DOM is loaded
document.addEventListener("DOMContentLoaded", () => {
  window.app = new TodoApp();
});

// Add shake animation to CSS dynamically
const style = document.createElement("style");
style.textContent = `
    @keyframes shake {
        0%, 100% { transform: translateX(0); }
        25% { transform: translateX(-5px); }
        75% { transform: translateX(5px); }
    }
`;
document.head.appendChild(style);
