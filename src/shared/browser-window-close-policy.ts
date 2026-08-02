// Why: the synthetic drive keeps this marker absolute under Windows file-URL rules; main removes it before guest load.
export const BROWSER_WINDOW_CLOSE_ALLOWED_PRELOAD = 'file:///C:/__orca_window_close_allowed__'
