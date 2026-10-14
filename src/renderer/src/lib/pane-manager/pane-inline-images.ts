import type { ImageAddon } from '@xterm/addon-image'
import type { Terminal } from '@xterm/xterm'
import { refreshTerminalDa1Owner } from './terminal-da1-ownership'
import type { ManagedPaneInternal } from './pane-manager-types'
import {
  getTerminalImageAddonConstructor,
  primeTerminalImageAddon,
  rearmTerminalImageAddonLoad,
  setTerminalImageAddonLoadHandlers
} from './terminal-image-addon-loader'
import { buildInlineImageAddonOptions } from './terminal-inline-image-options'

// Panes whose setting is on but that opened before the lazy addon chunk
// resolved, with the cache size to use. The loader's onLoaded handler drains
// them into a real attach.
const panesAwaitingImageAddon = new Map<ManagedPaneInternal, number>()

// Keyed on the terminal, not the pane: PTY connections hold a toPublicPane()
// wrapper, which does not carry imageAddon.
const terminalsRenderingInlineImages = new WeakSet<Terminal>()

/** True only once the addon is really attached — not while its chunk loads or after it fails. */
export function terminalRendersInlineImages(terminal: Terminal): boolean {
  return terminalsRenderingInlineImages.has(terminal)
}

setTerminalImageAddonLoadHandlers({
  onLoaded: () => {
    // attachInlineImages removes the pane it handles from the set, so deleting
    // the current iterator entry mid-iteration is safe.
    for (const [pane, storageLimitMb] of panesAwaitingImageAddon) {
      try {
        attachInlineImages(pane, storageLimitMb)
      } catch (err) {
        // Why per-pane: this runs inside the loader promise, so one bad pane
        // must not strand the rest of the drain or raise an unhandled rejection.
        panesAwaitingImageAddon.delete(pane)
        console.warn('[terminal] deferred inline-image attach failed for pane', pane.id, err)
      }
    }
  }
})

/** Attach in place so enabling images preserves scrollback and the PTY binding. */
export function attachInlineImages(pane: ManagedPaneInternal, storageLimitMb: number): void {
  if (pane.imageAddon) {
    return
  }
  const ImageAddonConstructor = getTerminalImageAddonConstructor()
  if (!ImageAddonConstructor) {
    // Chunk not resolved yet: latch and let the loader's onLoaded attach us.
    pane.imageAttachmentDeferred = true
    panesAwaitingImageAddon.set(pane, storageLimitMb)
    void primeTerminalImageAddon()
    return
  }
  panesAwaitingImageAddon.delete(pane)
  pane.imageAttachmentDeferred = false
  let imageAddon: ImageAddon | null = null
  try {
    imageAddon = new ImageAddonConstructor(buildInlineImageAddonOptions(storageLimitMb))
    pane.terminal.loadAddon(imageAddon)
    pane.imageAddon = imageAddon
    terminalsRenderingInlineImages.add(pane.terminal)
  } catch (err) {
    console.warn('[terminal] inline-image addon failed to attach for pane', pane.id, err)
    try {
      imageAddon?.dispose()
    } catch {
      /* Activation may have failed before addon disposal was fully initialized. */
    }
    terminalsRenderingInlineImages.delete(pane.terminal)
    pane.imageAddon = null
  } finally {
    refreshTerminalDa1Owner(pane.terminal)
  }
}

export function detachInlineImages(pane: ManagedPaneInternal): void {
  panesAwaitingImageAddon.delete(pane)
  pane.imageAttachmentDeferred = false
  terminalsRenderingInlineImages.delete(pane.terminal)
  if (pane.imageAddon) {
    try {
      pane.imageAddon.dispose()
    } catch {
      /* ignore */
    }
    pane.imageAddon = null
  }
}

/** Enable or disable inline images in-place on a running terminal. */
export function setInlineImagesEnabled(
  pane: ManagedPaneInternal,
  enabled: boolean,
  storageLimitMb: number
): void {
  if (enabled) {
    if (pane.imageAddon) {
      // Why: the patched addon reads storageLimit live for its Kitty blob and
      // decoder budgets, and the setter evicts down to the new cap.
      if (pane.imageAddon.storageLimit !== storageLimitMb) {
        pane.imageAddon.storageLimit = storageLimitMb
      }
      return
    }
    attachInlineImages(pane, storageLimitMb)
  } else {
    rearmTerminalImageAddonLoad()
    detachInlineImages(pane)
  }
}
