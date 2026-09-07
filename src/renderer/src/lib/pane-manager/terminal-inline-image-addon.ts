import type { IImageAddonOptions, ImageAddon } from '@xterm/addon-image'
import type { ManagedPaneInternal } from './pane-manager-types'

// Why this exists: the embedded terminal parsed no image protocol at all, so
// yazi/chafa/timg fell back to block art and agents that emit screenshots
// (pi, Kimi, OpenCode) left a blank gap (#11668, #13336, #18414, #18481).
// `@xterm/addon-image` is the xterm.js-org addon that handles SIXEL, the
// iTerm2 inline-image protocol (OSC 1337) and part of the kitty graphics
// protocol, and it answers DA1/CSI t size probes so TUIs can detect support.
//
// Why deferred: the addon is ~80 KB and only matters once a terminal opens, so
// keep it off the boot chunk the same way the WebGL addon is. The load stays
// eager — openTerminal kicks it off — but the constructor is memoised so every
// pane after the first attaches synchronously.

export const TERMINAL_INLINE_IMAGE_OPTIONS: Partial<IImageAddonOptions> = {
  sixelSupport: true,
  iipSupport: true,
  // Why 64 MB (default 128): images are held as unpacked RGBA canvases and a
  // long agent session can stream many screenshots. FIFO eviction keeps the
  // renderer bounded; evicted images leave the addon's placeholder in
  // scrollback rather than a silent gap.
  storageLimit: 64
}

type ImageAddonConstructor = new (options?: Partial<IImageAddonOptions>) => ImageAddon

let imageAddonConstructor: ImageAddonConstructor | null = null
let imageAddonLoad: Promise<ImageAddonConstructor | null> | null = null

export function primeTerminalInlineImageAddon(): Promise<ImageAddonConstructor | null> {
  if (imageAddonConstructor) {
    return Promise.resolve(imageAddonConstructor)
  }
  if (!imageAddonLoad) {
    imageAddonLoad = import('@xterm/addon-image').then(
      (module) => {
        imageAddonConstructor = module.ImageAddon
        return imageAddonConstructor
      },
      (error) => {
        // Why clear the memo: a transient chunk failure must not strand every
        // later pane without images for the whole session.
        imageAddonLoad = null
        console.warn('[terminal] inline image addon failed to load — images disabled:', error)
        return null
      }
    )
  }
  return imageAddonLoad
}

function loadInlineImageAddon(pane: ManagedPaneInternal, Ctor: ImageAddonConstructor): void {
  if (pane.imageAddon) {
    return
  }
  try {
    const imageAddon = new Ctor(TERMINAL_INLINE_IMAGE_OPTIONS)
    pane.terminal.loadAddon(imageAddon)
    pane.imageAddon = imageAddon
  } catch (err) {
    console.warn('[terminal] inline image addon failed to attach for pane', pane.id, err)
    pane.imageAddon = null
  }
}

/** Attach inline-image decoding to an opened terminal. Safe to call before the
 *  addon chunk has loaded: the attach completes once it resolves, unless the
 *  pane was disposed in the meantime. */
export function attachInlineImages(pane: ManagedPaneInternal): void {
  if (pane.imageAddon) {
    return
  }
  if (imageAddonConstructor) {
    loadInlineImageAddon(pane, imageAddonConstructor)
    return
  }
  const attachToken = (pane.inlineImageAttachToken ?? 0) + 1
  pane.inlineImageAttachToken = attachToken
  void primeTerminalInlineImageAddon().then((Ctor) => {
    // Why the token: disposePane bumps it, so a load that resolves after the
    // pane closed must not push an addon into a disposed terminal.
    if (!Ctor || pane.inlineImageAttachToken !== attachToken) {
      return
    }
    loadInlineImageAddon(pane, Ctor)
  })
}

export function disposeInlineImages(pane: ManagedPaneInternal): void {
  pane.inlineImageAttachToken = (pane.inlineImageAttachToken ?? 0) + 1
  if (!pane.imageAddon) {
    return
  }
  try {
    pane.imageAddon.dispose()
  } catch {
    /* ignore */
  }
  pane.imageAddon = null
}

/** Test seam: forget the memoised constructor so a spec can exercise the load path again. */
export function resetTerminalInlineImageAddonForTests(): void {
  imageAddonConstructor = null
  imageAddonLoad = null
}
