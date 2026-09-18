import { ImageAddon } from '@xterm/addon-image'

// Why: many panes share one renderer process, so the per-terminal FIFO image
// cache stays well below the addon default (128 MB) to bound total memory.
const IMAGE_STORAGE_LIMIT_MB = 32

/** Inline image support (SIXEL, iTerm2 IIP, Kitty graphics) for a pane terminal. */
export function createTerminalImageAddon(): ImageAddon {
  return new ImageAddon({
    // Why: Orca answers CSI 14t / 16t itself (terminal-capability-replies.ts)
    // and gates replies on replay/mobile authority; the addon must not add a
    // second, ungated responder for the same queries.
    enableSizeReports: false,
    sixelSupport: true,
    iipSupport: true,
    kittySupport: true,
    storageLimit: IMAGE_STORAGE_LIMIT_MB
  })
}
