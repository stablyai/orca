import type { WebglAddon } from '@xterm/addon-webgl'

// Match BaseRenderLayer's 2048 cap so resize does not thrash charAtlasCache and Apple Silicon
// MAX_TEXTURE_SIZE (16384) cannot merge pages into 1.33 GiB mipmapped RGBA textures (#38108).
export const MAX_WEBGL_ATLAS_TEXTURE_SIZE = 2048
const UNUSED_ATLAS_TEXTURE_PIXEL = new Uint8Array([255, 0, 0, 255])

type AtlasWebglContext = {
  readonly TEXTURE0?: number
  readonly TEXTURE_2D?: number
  readonly RGBA?: number
  readonly UNSIGNED_BYTE?: number
  activeTexture?: (texture: number) => void
  bindTexture?: (target: number, texture: WebGLTexture | null) => void
  texImage2D?: (
    target: number,
    level: number,
    internalformat: number,
    width: number,
    height: number,
    border: number,
    format: number,
    type: number,
    pixels: ArrayBufferView | null
  ) => void
}

type XtermTextureAtlas = {
  constructor: { maxTextureSize?: number }
  pageLayoutVersion?: number
  pages?: { canvas: HTMLCanvasElement; version: number }[]
  _config?: { deviceMaxTextureSize?: number }
  clearTexture?: () => void
  _createNewPage?: () => unknown
}

type XtermGlyphRenderer = {
  _atlas?: XtermTextureAtlas
  _atlasTextures?: { texture: WebGLTexture; version: number }[]
  beginFrame?: () => boolean
  invalidateAtlasTextures?: () => void
}

type XtermWebglRendererInternals = {
  _gl?: AtlasWebglContext
  _deviceMaxTextureSize?: number
  _charAtlas?: XtermTextureAtlas
  _glyphRenderer?: { value?: XtermGlyphRenderer }
  _refreshCharAtlas?: () => void
  dispose?: () => void
}

type XtermWebglAddonWithInternals = WebglAddon & {
  onChangeTextureAtlas?: (listener: () => void) => unknown
  onRemoveTextureAtlasCanvas?: (listener: (canvas: HTMLCanvasElement) => void) => unknown
  _renderer?: XtermWebglRendererInternals
}

const patchedGlyphRenderers = new WeakSet<XtermGlyphRenderer>()
const patchedRenderers = new WeakSet<XtermWebglRendererInternals>()
const patchedAtlases = new WeakSet<XtermTextureAtlas>()
const renderersByAtlas = new WeakMap<XtermTextureAtlas, Set<XtermWebglRendererInternals>>()
const atlasByRenderer = new WeakMap<XtermWebglRendererInternals, XtermTextureAtlas>()
const lastShrunkLayoutVersionByRenderer = new WeakMap<XtermWebglRendererInternals, number>()

/** Narrow a WebGL addon reference before reading private xterm renderer fields. */
function hasAddonInternals(
  webglAddon: WebglAddon | null | undefined
): webglAddon is XtermWebglAddonWithInternals {
  return typeof webglAddon === 'object' && webglAddon !== null
}

/** Replace GPU texture allocations from `startIndex` upward with 1x1 pixels so unused slots release VRAM. */
function shrinkWebglAtlasTexturesFrom(
  renderer: XtermWebglRendererInternals,
  startIndex: number
): void {
  const gl = renderer._gl
  const textures = renderer._glyphRenderer?.value?._atlasTextures
  if (
    !gl?.activeTexture ||
    !gl.bindTexture ||
    !gl.texImage2D ||
    typeof gl.TEXTURE0 !== 'number' ||
    typeof gl.TEXTURE_2D !== 'number' ||
    typeof gl.RGBA !== 'number' ||
    typeof gl.UNSIGNED_BYTE !== 'number' ||
    !Array.isArray(textures)
  ) {
    return
  }
  for (let i = Math.max(0, startIndex); i < textures.length; i += 1) {
    const entry = textures[i]
    if (!entry) {
      continue
    }
    entry.version = -1
    gl.activeTexture(gl.TEXTURE0 + i)
    gl.bindTexture(gl.TEXTURE_2D, entry.texture)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      UNUSED_ATLAS_TEXTURE_PIXEL
    )
  }
}

/** Invalidate and shrink a renderer's idle atlas texture slots once per shared atlas layout version. */
function invalidateRendererForAtlasLayout(
  renderer: XtermWebglRendererInternals,
  atlas: XtermTextureAtlas | undefined
): void {
  const layoutVersion = atlas?.pageLayoutVersion
  if (typeof layoutVersion === 'number') {
    if (lastShrunkLayoutVersionByRenderer.get(renderer) === layoutVersion) {
      return
    }
    lastShrunkLayoutVersionByRenderer.set(renderer, layoutVersion)
  }
  const glyphRenderer = renderer._glyphRenderer?.value
  if (typeof glyphRenderer?.invalidateAtlasTextures === 'function') {
    glyphRenderer.invalidateAtlasTextures()
    return
  }
  shrinkWebglAtlasTexturesFrom(renderer, atlas?.pages?.length ?? 0)
}

/** Shrink idle GPU texture slots across all renderers sharing `atlas`, including hidden sibling panes. */
function shrinkSharedAtlasRenderers(
  atlas: XtermTextureAtlas | undefined,
  excludingRenderer?: XtermWebglRendererInternals
): void {
  const peers = atlas ? renderersByAtlas.get(atlas) : undefined
  if (!atlas || !peers) {
    return
  }
  for (const peerRenderer of peers) {
    if (peerRenderer !== excludingRenderer) {
      invalidateRendererForAtlasLayout(peerRenderer, atlas)
    }
  }
}

/** Track which renderers share an xterm TextureAtlas and hook atlas page removals to shrink hidden siblings. */
function registerRendererAtlas(
  renderer: XtermWebglRendererInternals,
  atlas: XtermTextureAtlas | undefined
): void {
  const previousAtlas = atlasByRenderer.get(renderer)
  if (previousAtlas && previousAtlas !== atlas) {
    renderersByAtlas.get(previousAtlas)?.delete(renderer)
    atlasByRenderer.delete(renderer)
  }
  if (!atlas) {
    return
  }
  if (
    typeof atlas.constructor.maxTextureSize === 'number' &&
    atlas.constructor.maxTextureSize > MAX_WEBGL_ATLAS_TEXTURE_SIZE
  ) {
    atlas.constructor.maxTextureSize = MAX_WEBGL_ATLAS_TEXTURE_SIZE
  }
  let peers = renderersByAtlas.get(atlas)
  if (!peers) {
    peers = new Set()
    renderersByAtlas.set(atlas, peers)
  }
  peers.add(renderer)
  atlasByRenderer.set(renderer, atlas)
  if (
    previousAtlas !== atlas &&
    typeof atlas.pageLayoutVersion === 'number' &&
    !lastShrunkLayoutVersionByRenderer.has(renderer)
  ) {
    lastShrunkLayoutVersionByRenderer.set(renderer, atlas.pageLayoutVersion)
  }
  if (patchedAtlases.has(atlas)) {
    return
  }
  patchedAtlases.add(atlas)
  if (typeof atlas.clearTexture === 'function') {
    const originalClearTexture = atlas.clearTexture.bind(atlas)
    atlas.clearTexture = () => {
      originalClearTexture()
      shrinkSharedAtlasRenderers(atlas)
    }
  }
  if (typeof atlas._createNewPage === 'function') {
    const originalCreateNewPage = atlas._createNewPage.bind(atlas)
    atlas._createNewPage = () => {
      const versionBefore = atlas.pageLayoutVersion
      const page = originalCreateNewPage()
      if (atlas.pageLayoutVersion !== versionBefore) {
        shrinkSharedAtlasRenderers(atlas)
      }
      return page
    }
  }
}

/** Clamp xterm's WebGL atlas page limit to 2048 and hook invalidation/frame layout changes to shrink idle texture slots. */
function capXtermWebglAtlasRenderer(renderer: XtermWebglRendererInternals): void {
  if (
    typeof renderer._deviceMaxTextureSize === 'number' &&
    renderer._deviceMaxTextureSize > MAX_WEBGL_ATLAS_TEXTURE_SIZE
  ) {
    renderer._deviceMaxTextureSize = MAX_WEBGL_ATLAS_TEXTURE_SIZE
    if (typeof renderer._refreshCharAtlas === 'function') {
      // Re-acquire through CharAtlasCache with 2048 before touching _config so panes share one 2048 entry.
      renderer._refreshCharAtlas()
    }
  }
  const atlas = renderer._charAtlas ?? renderer._glyphRenderer?.value?._atlas
  if (
    typeof renderer._refreshCharAtlas !== 'function' &&
    atlas?._config &&
    typeof atlas._config.deviceMaxTextureSize === 'number' &&
    atlas._config.deviceMaxTextureSize > MAX_WEBGL_ATLAS_TEXTURE_SIZE
  ) {
    atlas._config.deviceMaxTextureSize = MAX_WEBGL_ATLAS_TEXTURE_SIZE
  }
  registerRendererAtlas(renderer, atlas)
  if (typeof renderer.dispose === 'function' && !patchedRenderers.has(renderer)) {
    patchedRenderers.add(renderer)
    const originalDispose = renderer.dispose.bind(renderer)
    renderer.dispose = () => {
      registerRendererAtlas(renderer, undefined)
      originalDispose()
    }
  }
  const glyphRenderer = renderer._glyphRenderer?.value
  if (
    glyphRenderer &&
    typeof glyphRenderer.invalidateAtlasTextures === 'function' &&
    !patchedGlyphRenderers.has(glyphRenderer)
  ) {
    patchedGlyphRenderers.add(glyphRenderer)
    const originalInvalidate = glyphRenderer.invalidateAtlasTextures.bind(glyphRenderer)
    glyphRenderer.invalidateAtlasTextures = () => {
      originalInvalidate()
      const currentAtlas = glyphRenderer._atlas ?? renderer._charAtlas
      registerRendererAtlas(renderer, currentAtlas)
      if (typeof currentAtlas?.pageLayoutVersion === 'number') {
        lastShrunkLayoutVersionByRenderer.set(renderer, currentAtlas.pageLayoutVersion)
      }
      // render() only re-uploads 0..pages.length - 1; shrink higher slots after merges/evictions.
      shrinkWebglAtlasTexturesFrom(renderer, currentAtlas?.pages?.length ?? 0)
    }
    if (typeof glyphRenderer.beginFrame === 'function') {
      const originalBeginFrame = glyphRenderer.beginFrame.bind(glyphRenderer)
      glyphRenderer.beginFrame = () => {
        const layoutChanged = originalBeginFrame()
        if (layoutChanged) {
          invalidateRendererForAtlasLayout(renderer, glyphRenderer._atlas ?? renderer._charAtlas)
        }
        return layoutChanged
      }
    }
  }
}

/** Bound a WebGL addon's glyph atlas page dimensions and reclaim discarded canvas/texture backing stores. */
export function boundXtermWebglAtlasMemory(webglAddon: WebglAddon): void {
  if (!hasAddonInternals(webglAddon)) {
    return
  }
  try {
    webglAddon.onRemoveTextureAtlasCanvas?.((removedCanvas) => {
      removedCanvas.width = 0
      removedCanvas.height = 0
    })
    webglAddon.onChangeTextureAtlas?.(() => {
      if (webglAddon._renderer) {
        capXtermWebglAtlasRenderer(webglAddon._renderer)
      }
    })
    if (webglAddon._renderer) {
      capXtermWebglAtlasRenderer(webglAddon._renderer)
    }
  } catch {}
}

/** Shrink all GPU atlas texture slots to 1x1 after clearing an addon's glyph atlas and reclaim idle sibling slots. */
export function shrinkClearedWebglAtlasTextures(webglAddon: WebglAddon | null): void {
  if (!hasAddonInternals(webglAddon) || !webglAddon._renderer) {
    return
  }
  const renderer = webglAddon._renderer
  const atlas = renderer._charAtlas ?? renderer._glyphRenderer?.value?._atlas
  if (typeof atlas?.pageLayoutVersion === 'number') {
    lastShrunkLayoutVersionByRenderer.set(renderer, atlas.pageLayoutVersion)
  }
  // Hidden panes do not redraw on clear; shrink every slot to 1x1 until reveal re-uploads page 0.
  shrinkWebglAtlasTexturesFrom(renderer, 0)
  shrinkSharedAtlasRenderers(atlas, renderer)
}
