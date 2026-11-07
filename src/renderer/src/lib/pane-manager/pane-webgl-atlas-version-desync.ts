import type { ManagedPaneInternal } from './pane-manager-types'
import { isManagedPaneDisplayNone } from './pane-display-visibility'
import { isSynchronizedOutputHeld } from './terminal-render-pause-release'

type CharAtlasPageLike = {
  version?: number
}

type CharAtlasLike = {
  pageLayoutVersion?: number
  _pageLayoutVersion?: number
  pages?: CharAtlasPageLike[]
}

type GlyphRendererLike = {
  _lastSeenPageLayoutVersion?: number
  _atlasTextures?: CharAtlasPageLike[]
}

type WebglRendererLike = {
  _charAtlas?: CharAtlasLike | null
  _glyphRenderer?: { value?: GlyphRendererLike | null } | GlyphRendererLike | null
}

type RenderServiceLike = {
  _isPaused?: boolean
  _renderer?: { value?: WebglRendererLike | null } | WebglRendererLike | null
}

type TerminalWithWebglInternals = {
  _core?: {
    _renderService?: RenderServiceLike | null
  }
}

function unwrapValue<T extends object>(
  holder: { value?: T | null } | T | null | undefined
): T | null {
  if (!holder || typeof holder !== 'object') {
    return null
  }
  if ('value' in holder) {
    return holder.value ?? null
  }
  return holder as T
}

/**
 * Detects whether a visible WebGL pane's per-context glyph texture state still lags behind
 * xterm's shared `_charAtlas` after viewport presentation (for example after sibling atlas page
 * eviction/relayout while hidden, including short prompts below the pixel sentinel's cell floor).
 */
export function hasPaneWebglAtlasVersionDesync(pane: ManagedPaneInternal): boolean {
  if (
    !pane.webglAddon ||
    pane.webglDisabledAfterContextLoss ||
    isManagedPaneDisplayNone(pane) ||
    isSynchronizedOutputHeld(pane.terminal)
  ) {
    return false
  }
  try {
    const service = (pane.terminal as unknown as TerminalWithWebglInternals | null)?._core
      ?._renderService
    if (!service || service._isPaused === true) {
      return false
    }
    const renderer = unwrapValue(service._renderer)
    const charAtlas = renderer?._charAtlas
    const glyphRenderer = unwrapValue(renderer?._glyphRenderer)
    if (!charAtlas || !glyphRenderer) {
      return false
    }

    const atlasLayoutVersion = charAtlas.pageLayoutVersion ?? charAtlas._pageLayoutVersion
    const glyphLayoutVersion = glyphRenderer._lastSeenPageLayoutVersion
    if (
      typeof atlasLayoutVersion === 'number' &&
      typeof glyphLayoutVersion === 'number' &&
      atlasLayoutVersion !== glyphLayoutVersion
    ) {
      return true
    }

    const pages = charAtlas.pages
    const textures = glyphRenderer._atlasTextures
    if (!Array.isArray(pages) || !Array.isArray(textures) || pages.length === 0) {
      return false
    }
    if (textures.length < pages.length) {
      return true
    }
    for (let index = 0; index < pages.length; index++) {
      const pageVersion = pages[index]?.version
      const textureVersion = textures[index]?.version
      if (
        typeof pageVersion === 'number' &&
        typeof textureVersion === 'number' &&
        pageVersion !== textureVersion
      ) {
        return true
      }
    }
    return false
  } catch {
    return false
  }
}
