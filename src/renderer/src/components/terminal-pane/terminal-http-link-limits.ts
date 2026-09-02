export const TERMINAL_HTTP_URL_MAX_LENGTH = 2048

// Why: punctuation can form a valid one-character continuation row, so the
// URL length limit is also the only complete finite bound on framed rows.
export const TERMINAL_HTTP_URL_MAX_HARD_WRAPPED_ROWS = TERMINAL_HTTP_URL_MAX_LENGTH
