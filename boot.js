// Runs before the page paints, so a new tab never flashes the wrong theme or
// board, and the toolbar popup gets its compact layout straight away.
(() => {
  const root = document.documentElement;
  const read = (key) => {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  };

  let isPopup = new URLSearchParams(location.search).has("popup");
  if (!isPopup) {
    try {
      isPopup = chrome.extension.getViews({ type: "popup" }).includes(window);
    } catch (error) {
      isPopup = false;
    }
  }
  root.classList.toggle("is-popup", isPopup);

  const theme = read("taskPlannerTheme");
  root.dataset.theme =
    theme === "light" || theme === "dark"
      ? theme
      : matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark";
  root.dataset.board = read("taskPlannerBoard") === "goal" ? "goal" : "todo";
})();
