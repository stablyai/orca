/**
 * Set on the CLI that a direct `<binary> --no-sandbox serve` execs into: the CLI has no Chromium
 * switches of its own, so it re-applies the caller's --no-sandbox to every Electron it starts.
 */
export const ELECTRON_NO_SANDBOX_REQUEST_ENV = 'ORCA_ELECTRON_NO_SANDBOX'
