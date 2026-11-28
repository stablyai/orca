// Why: tray, menu-bar and notch defaults live together so platform presence is tuned in one place.
export const SYSTEM_PRESENCE_DEFAULTS = {
  minimizeToTrayOnClose: false,
  // Why: default-on everywhere so it round-trips across platforms; only darwin acts on it.
  showMenuBarIcon: true,
  // Why default-on: the indicator only helps if it is already there when an agent blocks.
  showNotchStatus: true
}
