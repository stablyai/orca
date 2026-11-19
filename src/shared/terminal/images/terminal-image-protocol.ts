// External image-capable agents read this encoder hint; the addon also renders DA1-advertised Sixel and iTerm2 IIP.
export const ORCA_IMAGE_PROTOCOL_ENV = 'ORCA_IMAGE_PROTOCOL'

// Prefer Kitty for truecolor without a palette limit.
export const ORCA_IMAGE_PROTOCOL_VALUE = 'kitty'

// Carried from the remote launch caller to the PTY launch boundary.
export const ORCA_TERMINAL_IMAGE_VIEWER_ENV = 'ORCA_TERMINAL_IMAGE_VIEWER'

// Codex checks for this variable before its terminal allowlist. Zero is a synthetic window ID.
export const CODEX_KITTY_WINDOW_ID = '0'
