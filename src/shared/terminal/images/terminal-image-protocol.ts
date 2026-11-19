// External image-capable agents read this encoder hint; the addon also renders DA1-advertised Sixel and iTerm2 IIP.
export const ORCA_IMAGE_PROTOCOL_ENV = 'ORCA_IMAGE_PROTOCOL'

// Prefer Kitty for truecolor without a palette limit.
export const ORCA_IMAGE_PROTOCOL_VALUE = 'kitty'

// oh-my-pi's TUI gates image rendering on this variable; ORCA_IMAGE_PROTOCOL alone is not read (#39536).
export const PI_FORCE_IMAGE_PROTOCOL_ENV = 'PI_FORCE_IMAGE_PROTOCOL'
export const PI_FORCE_IMAGE_PROTOCOL_VALUE = 'kitty'
