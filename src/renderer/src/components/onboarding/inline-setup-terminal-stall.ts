// Why: skills add blocks on stdin without -y; bound the wait so Settings cannot
// look identical to "Not installed" while the PTY sleeps forever.
export const INLINE_SETUP_TERMINAL_STALL_TIMEOUT_MS = 45_000
