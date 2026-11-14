import type { IImageAddonOptions } from '@xterm/addon-image'

// Cap each encoded sequence at 8MB to bound decoder memory/parser work while allowing normal images.
const IMAGE_SEQUENCE_SIZE_LIMIT = 8 * 1024 * 1024

// This is one decoded RGBA pool, not a pane-wide cap: retained Kitty blobs add 32MB and pending WASM decoders ~3×11MB. Worst case is ~98MB/pane with no cross-pane budget.
const IMAGE_STORAGE_LIMIT_MB = 32

export function buildInlineImageAddonOptions(): IImageAddonOptions {
  return {
    // Orca already answers CSI 14t/16t via its pixel-size responder.
    enableSizeReports: false,
    storageLimit: IMAGE_STORAGE_LIMIT_MB,
    pixelLimit: (IMAGE_STORAGE_LIMIT_MB * 1000000) / 4,
    sixelSizeLimit: IMAGE_SEQUENCE_SIZE_LIMIT,
    iipSizeLimit: IMAGE_SEQUENCE_SIZE_LIMIT,
    kittySizeLimit: IMAGE_SEQUENCE_SIZE_LIMIT
  }
}
