export const TERMINAL_HTTP_URL_MAX_LENGTH = 2048

// Punctuation-only continuation rows are valid, so URL length also bounds framed row count.
export const TERMINAL_HTTP_URL_MAX_HARD_WRAPPED_ROWS = TERMINAL_HTTP_URL_MAX_LENGTH
