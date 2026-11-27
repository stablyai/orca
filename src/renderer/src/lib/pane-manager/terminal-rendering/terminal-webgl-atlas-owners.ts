import type { ManagedPaneInternal } from '../pane-manager-types'
import {
  forEachVisibleInternalPane,
  isElementInVisiblePaneManager,
  type RegisteredPaneManager
} from '../pane-manager-registry'
import { isManagedPaneDisplayNone } from '../terminal-fit/pane-display-visibility'
import { getWindowParkVisible } from '../../window-activity/window-park-visibility'
import { presentPaneViewport } from './pane-viewport-present'
import { paneIsCoveredByNativeChat } from '@/components/terminal-pane/chat/native-chat-covered-pane'
import type { GlyphAtlasLike } from './terminal-webgl-atlas-sampling'

type WebglInternals = {
  _renderer?: { _charAtlas?: GlyphAtlasLike; _gl?: { isContextLost?: () => boolean } }
}

export function atlasOfPane(pane: ManagedPaneInternal): GlyphAtlasLike | undefined {
  try {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pinned addon stores its atlas on the private renderer; check the pages array before use.
    const atlas = (pane.webglAddon as unknown as WebglInternals | null)?._renderer?._charAtlas
    return atlas && Array.isArray(atlas.pages) ? atlas : undefined
  } catch {
    return undefined
  }
}

export function isWindowPresented(): boolean {
  return getWindowParkVisible()
}

/** A leaf currently showing this atlas on screen through a live WebGL context. */
export function isEligibleOwner(
  pane: ManagedPaneInternal,
  atlas: GlyphAtlasLike,
  manager?: RegisteredPaneManager
): boolean {
  try {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pinned addon's renderer holds the GL context privately; verify the liveness method before calling it.
    const renderer = (pane.webglAddon as unknown as WebglInternals | null)?._renderer
    const terminalElement = pane.terminal.element
    return (
      !!pane.webglAddon &&
      !pane.webglDisabledAfterContextLoss &&
      typeof renderer?._gl?.isContextLost === 'function' &&
      renderer._gl.isContextLost() === false &&
      atlasOfPane(pane) === atlas &&
      pane.container.isConnected &&
      terminalElement?.isConnected === true &&
      isElementInVisiblePaneManager(pane.container, manager) &&
      !isManagedPaneDisplayNone(pane) &&
      !paneIsCoveredByNativeChat(pane)
    )
  } catch {
    return false
  }
}

export function findEligibleOwner(atlas: GlyphAtlasLike): ManagedPaneInternal | undefined {
  let owner: ManagedPaneInternal | undefined
  forEachVisibleInternalPane((pane, manager) => {
    if (isEligibleOwner(pane, atlas, manager)) {
      owner = pane
      return true
    }
    return false
  })
  return owner
}

export function presentEligibleOwners(atlas: GlyphAtlasLike): void {
  forEachVisibleInternalPane((pane, manager) => {
    if (isEligibleOwner(pane, atlas, manager)) {
      try {
        presentPaneViewport(pane)
      } catch {
        // One owner's failed present must not stop its siblings.
      }
    }
  })
}
