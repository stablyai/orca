/** The most a panel or editor frame file may weigh: its entry, scripts and modules. */
export const PLUGIN_PANEL_ENTRY_MAX_BYTES = 10 * 1024 * 1024
/** Source modules are read whole and transpiled per load, so they get a tighter cap. */
export const PLUGIN_SOURCE_MODULE_MAX_BYTES = 1024 * 1024
/** Streamed assets (images, fonts, media); the whole plugin tree is capped at 50 MiB anyway. */
export const PLUGIN_FRAME_ASSET_MAX_BYTES = 32 * 1024 * 1024
/** Documents, scripts and WASM are read whole to check their digest, so they get a lower cap. */
export const PLUGIN_FRAME_CHECKED_MAX_BYTES = 16 * 1024 * 1024
