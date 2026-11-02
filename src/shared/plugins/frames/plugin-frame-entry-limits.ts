/** The most a panel or editor frame file may weigh: its entry, scripts and modules. */
export const PLUGIN_PANEL_ENTRY_MAX_BYTES = 10 * 1024 * 1024
/** Source modules are read whole and transpiled per load, so they get a tighter cap. */
export const PLUGIN_SOURCE_MODULE_MAX_BYTES = 1024 * 1024
