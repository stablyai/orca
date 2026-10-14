import type { IImageAddonOptions } from '@xterm/addon-image'

// Per-sequence byte ceiling for every protocol. Bounds the decoder's working
// buffer so one oversized paste cannot stall the parser or balloon memory; 8 MB
// of encoded data still covers any reasonable inline image.
const IMAGE_SEQUENCE_SIZE_LIMIT = 8 * 1024 * 1024

// The user-set per-pane decoded-image cache (MB of RGBA) is ONE pool, not the
// pane's ceiling: Orca's addon patch keys two more budgets off the same number —
// retained encoded Kitty blobs (another N MB) and pending base64 WASM decoders
// (~3 x 11 MB, since one decoder's capacity is the 8 MiB sequence limit expanded
// 4/3 plus a page). Worst case is therefore ~(2N + 33) MB per pane (~97 MB at the
// 32 MB default), and nothing governs the sum across panes.

/** Bound image sequences and per-pane caches without enabling duplicate size reports. */
export function buildInlineImageAddonOptions(storageLimitMb: number): IImageAddonOptions {
  return {
    // Orca already answers CSI 14t/16t via its pixel-size responder.
    enableSizeReports: false,
    storageLimit: storageLimitMb,
    pixelLimit: (storageLimitMb * 1000000) / 4,
    sixelSizeLimit: IMAGE_SEQUENCE_SIZE_LIMIT,
    iipSizeLimit: IMAGE_SEQUENCE_SIZE_LIMIT,
    kittySizeLimit: IMAGE_SEQUENCE_SIZE_LIMIT
  }
}
