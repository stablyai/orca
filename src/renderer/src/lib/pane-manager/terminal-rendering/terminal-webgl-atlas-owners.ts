import type { ManagedPaneInternal } from '../pane-manager-types'
import { forEachVisibleInternalPane, isElementInVisiblePaneManager } from '../pane-manager-registry'
import { isManagedPaneDisplayNone } from '../terminal-fit/pane-display-visibility'
import { getWindowParkVisible } from '../../window-activity/window-park-visibility'
import { presentPaneViewport } from './pane-viewport-present'
import { paneIsCoveredByNativeChat } from '@/components/terminal-pane/chat/native-chat-covered-pane'
import type { GlyphAtlasLike } from './terminal-webgl-atlas-sampling'

type WebglInternals = {
  _renderer?: { _charAtlas?: unknown; _gl?: { isContextLost?: () => boolean } }
}

export function atlasOfPane(pane: ManagedPaneInternal): GlyphAtlasLike | undefined {
  try {
    const atlas = (pane.webglAddon as unknown as WebglInternals | null)?._renderer?._charAtlas as
      | GlyphAtlasLike
      | undefined
    return atlas && Array.isArray(atlas.pages) ? atlas : undefined
  } catch {
    return undefined
  }
}

export function isWindowPresented(): boolean {
  return (
    getWindowParkVisible() &&
    (typeof document === 'undefined' || document.visibilityState !== 'hidden')
  )
}

/** A leaf currently showing this atlas on screen through a live WebGL context. */
export function isEligibleOwner(pane: ManagedPaneInternal, atlas: GlyphAtlasLike): boolean {
  try {
    const renderer = (pane.webglAddon as unknown as WebglInternals | null)?._renderer
    const terminalElement = (pane.terminal as { element?: { isConnected?: boolean } }).element
    return (
      !!pane.webglAddon &&
      !pane.webglDisabledAfterContextLoss &&
      typeof renderer?._gl?.isContextLost === 'function' &&
      renderer._gl.isContextLost() === false &&
      atlasOfPane(pane) === atlas &&
      pane.container.isConnected &&
      terminalElement?.isConnected === true &&
      isElementInVisiblePaneManager(pane.container) &&
      !isManagedPaneDisplayNone(pane) &&
      !paneIsCoveredByNativeChat(pane)
    )
  } catch {
    return false
  }
}

export function presentEligibleOwners(atlas: GlyphAtlasLike): void {
  forEachVisibleInternalPane((pane) => {
    if (isEligibleOwner(pane, atlas)) {
      try {
        presentPaneViewport(pane)
      } catch {
        // One owner's failed present must not stop its siblings.
      }
    }
  })
}
