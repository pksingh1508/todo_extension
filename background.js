chrome.runtime.onInstalled.addListener(({ reason }) => {
  console.log(`Task Planner ${reason === "install" ? "installed" : "updated"}.`);
});
