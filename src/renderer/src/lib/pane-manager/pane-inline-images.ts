import {
  bindTerminalKittyReplayReset,
  readTerminalKittyImage,
  saveTerminalKittyImage,
  type KittyImageSnapshot
} from './terminal-kitty-replay-cache'
import type { ImageAddon } from '@xterm/addon-image'
import type { Terminal } from '@xterm/xterm'
import type { KittyFileRequest } from './terminal-kitty-file-reader'
import { readTerminalKittyFile } from './terminal-kitty-file-reader'
import { refreshTerminalDa1Owner } from './terminal-da1-ownership'
import type { ManagedPaneInternal } from './pane-manager-types'
import {
  getTerminalImageAddonConstructor,
  primeTerminalImageAddon,
  rearmTerminalImageAddonLoad,
  setTerminalImageAddonLoadHandlers
} from './terminal-image-addon-loader'
import { buildInlineImageAddonOptions } from './terminal-inline-image-options'
import { repaintTerminalAfterImageAdded } from './terminal-image-added-repaint'

// Queue enabled panes opened before the lazy chunk resolves; onLoaded drains them.
const panesAwaitingImageAddon = new Set<ManagedPaneInternal>()

// Key by terminal: PTY public pane wrappers lack imageAddon and differ from internal panes.
const terminalsRenderingInlineImages = new WeakSet<Terminal>()
const replayCleanup = new WeakMap<ManagedPaneInternal, () => void>()
const imageRepaintByPane = new WeakMap<ManagedPaneInternal, { dispose(): void }>()

export function terminalRendersInlineImages(terminal: Terminal): boolean {
  return terminalsRenderingInlineImages.has(terminal)
}

setTerminalImageAddonLoadHandlers({
  onLoaded: () => {
    for (const pane of panesAwaitingImageAddon) {
      try {
        attachInlineImages(pane)
      } catch (err) {
        // Contain per-pane errors inside the loader promise so one failure neither strands siblings nor escapes unhandled.
        panesAwaitingImageAddon.delete(pane)
        console.warn('[terminal] deferred inline-image attach failed for pane', pane.id, err)
      }
    }
  }
})

export function attachInlineImages(pane: ManagedPaneInternal): void {
  if (pane.imageAddon) {
    return
  }
  const ImageAddonConstructor = getTerminalImageAddonConstructor()
  if (!ImageAddonConstructor) {
    pane.imageAttachmentDeferred = true
    panesAwaitingImageAddon.add(pane)
    void primeTerminalImageAddon()
    return
  }
  panesAwaitingImageAddon.delete(pane)
  pane.imageAttachmentDeferred = false
  let imageAddon: ImageAddon | null = null
  try {
    const options = {
      ...buildInlineImageAddonOptions(),
      readKittyFile: (request: KittyFileRequest) => readTerminalKittyFile(pane.terminal, request),
      readKittyImage: (id: number) => readTerminalKittyImage(pane.terminal, id),
      onKittyImageChanged: (id: number, snapshot?: KittyImageSnapshot) =>
        saveTerminalKittyImage(pane.terminal, id, snapshot)
    }
    imageAddon = new ImageAddonConstructor(options)
    pane.terminal.loadAddon(imageAddon)
    pane.imageAddon = imageAddon
    replayCleanup.set(
      pane,
      bindTerminalKittyReplayReset(pane.terminal, () => {
        pane.imageAddon?.reset()
      })
    )
    const repaint = repaintTerminalAfterImageAdded(pane.terminal, imageAddon)
    if (repaint) {
      imageRepaintByPane.set(pane, repaint)
    }
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
  replayCleanup.get(pane)?.()
  replayCleanup.delete(pane)
  imageRepaintByPane.get(pane)?.dispose()
  imageRepaintByPane.delete(pane)
  if (pane.imageAddon) {
    try {
      pane.imageAddon.dispose()
    } catch {}
    pane.imageAddon = null
  }
}

export function setInlineImagesEnabled(pane: ManagedPaneInternal, enabled: boolean): void {
  if (enabled) {
    attachInlineImages(pane)
  } else {
    rearmTerminalImageAddonLoad()
    detachInlineImages(pane)
  }
}
