export const TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT = 512 * 1024
export const TERMINAL_SCROLLBACK_REPLAY_BYTE_LIMIT = 512 * 1024
export const TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT = 5 * 1024 * 1024
// N-02: a pane's saved copy (kept across quit only for remote, SSH and cloud panes) holds up to a
// local terminal's 5000 rows of coloured output; 512 KB held about 1000. In-memory buffers keep the
// session buffer limit above.
export const TERMINAL_SCROLLBACK_SAVED_PANE_BYTE_LIMIT = 2 * 1024 * 1024
