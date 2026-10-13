// Why its own module: the sandboxed guest preload bundles this, so it must not share a chunk with main.
export const BROWSER_GUEST_WINDOW_CLOSE_CHANNEL = 'orca:guest-window-close'
