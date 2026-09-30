// Agent-facing hint that Orca's terminal renders inline images and which protocol to prefer.
// No in-repo consumer: image-capable agents (e.g. pi, kimi) read it to pick an encoder.
// The xterm image addon also renders Sixel (advertised via DA1) and iTerm2 IIP.
export const ORCA_IMAGE_PROTOCOL_ENV = 'ORCA_IMAGE_PROTOCOL'

// Kitty graphics: truecolor and no palette limit, the richest of the three the addon renders.
export const ORCA_IMAGE_PROTOCOL_VALUE = 'kitty'
