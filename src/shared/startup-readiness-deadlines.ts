// The parent timer starts before the child can arm its daemon-preservation fail-open.
export const LOCAL_PTY_STARTUP_FAIL_OPEN_TIMEOUT_MS = 60_000
export const SERVE_REPLACEMENT_READY_TIMEOUT_MS = LOCAL_PTY_STARTUP_FAIL_OPEN_TIMEOUT_MS + 30_000
