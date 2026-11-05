import { describe, expect, it } from 'vitest'
import { WebglAddon } from '@xterm/addon-webgl'
import {
  boundXtermWebglAtlasMemory,
  shrinkClearedWebglAtlasTextures
} from './terminal-webgl-atlas-memory'

type SharedAtlas = {
  _config: { deviceMaxTextureSize: number }
  pageLayoutVersion: number
  pages: { canvas: { width: number; height: number }; version: number }[]
  clearTexture?: () => void
  _createNewPage?: () => unknown
  dispose?: () => void
}

/** Create a WebGL addon wired to a shared xterm TextureAtlas so sibling panes exercise the same cache entry. */
function createSiblingWebglAddon(atlas: SharedAtlas) {
  const resizedSlots: { unit: number; width: number; height: number }[] = []
  const textures = [
    { texture: {}, version: 3 },
    { texture: {}, version: 7 },
    { texture: {}, version: 9 }
  ]
  let activeUnit = 0
  let lastSeenPageLayoutVersion = atlas.pageLayoutVersion
  let onChangeAtlas: (() => void) | undefined
  const glyphRenderer = {
    _atlas: atlas,
    _atlasTextures: textures,
    beginFrame(): boolean {
      if (atlas.pageLayoutVersion !== lastSeenPageLayoutVersion) {
        lastSeenPageLayoutVersion = atlas.pageLayoutVersion
        return true
      }
      return false
    },
    invalidateAtlasTextures(): void {
      for (const entry of textures) {
        entry.version = -1
      }
    }
  }
  const renderer = {
    _deviceMaxTextureSize: 16384,
    _charAtlas: atlas,
    _glyphRenderer: { value: glyphRenderer },
    dispose(): void {},
    _gl: {
      TEXTURE0: 0x84c0,
      TEXTURE_2D: 0x0de1,
      RGBA: 0x1908,
      UNSIGNED_BYTE: 0x1401,
      activeTexture: (unit: number) => {
        activeUnit = unit - 0x84c0
      },
      bindTexture: () => {},
      texImage2D: (
        _target: number,
        _level: number,
        _internalformat: number,
        width: number,
        height: number
      ) => {
        resizedSlots.push({ unit: activeUnit, width, height })
      }
    }
  }
  const addon = new WebglAddon()
  Object.assign(addon, {
    clearTextureAtlas: () => {
      atlas.pages = [{ canvas: { width: 512, height: 512 }, version: 0 }]
      atlas.pageLayoutVersion += 1
    },
    onChangeTextureAtlas: (listener: () => void) => {
      onChangeAtlas = listener
    },
    _renderer: renderer
  })
  return {
    addon,
    renderer,
    glyphRenderer,
    textures,
    resizedSlots,
    notifyAtlasChanged: () => onChangeAtlas?.()
  }
}

describe('shared TextureAtlas sibling pane WebGL memory reclamation', () => {
  it('immediately shrinks a hidden sibling pane on shared atlas clear and on beginFrame layout changes', () => {
    class FakeSharedTextureAtlas {
      static maxTextureSize = 16384
      _config = { deviceMaxTextureSize: 16384 }
      pageLayoutVersion = 2
      pages = [
        { canvas: { width: 2048, height: 2048 }, version: 3 },
        { canvas: { width: 2048, height: 2048 }, version: 7 },
        { canvas: { width: 2048, height: 2048 }, version: 9 }
      ]
      _createNewPage(): unknown {
        this.pages = [
          { canvas: { width: 1024, height: 1024 }, version: 10 },
          { canvas: { width: 512, height: 512 }, version: 11 }
        ]
        this.pageLayoutVersion += 1
        return this.pages[1]
      }
    }
    const sharedAtlas = new FakeSharedTextureAtlas()
    const primary = createSiblingWebglAddon(sharedAtlas)
    const sibling = createSiblingWebglAddon(sharedAtlas)

    boundXtermWebglAtlasMemory(primary.addon)
    boundXtermWebglAtlasMemory(sibling.addon)
    // Re-running the atlas-change hook must not wrap callbacks a second time.
    sibling.notifyAtlasChanged()

    primary.addon.clearTextureAtlas()
    shrinkClearedWebglAtlasTextures(primary.addon)
    expect(primary.resizedSlots).toEqual([
      { unit: 0, width: 1, height: 1 },
      { unit: 1, width: 1, height: 1 },
      { unit: 2, width: 1, height: 1 }
    ])
    // Hidden sibling panes shrink idle slots 1..2 immediately without waiting for beginFrame().
    expect(sibling.textures.map((entry) => entry.version)).toEqual([-1, -1, -1])
    expect(sibling.resizedSlots).toEqual([
      { unit: 1, width: 1, height: 1 },
      { unit: 2, width: 1, height: 1 }
    ])

    // When the sibling later draws, beginFrame() still reports the layout change without redundant shrinks.
    sibling.resizedSlots.length = 0
    expect(sibling.glyphRenderer.beginFrame()).toBe(true)
    expect(sibling.resizedSlots).toEqual([])
    expect(sibling.glyphRenderer.beginFrame()).toBe(false)

    // A shared page merge inside _createNewPage() also shrinks hidden siblings immediately.
    primary.resizedSlots.length = 0
    sibling.resizedSlots.length = 0
    sharedAtlas._createNewPage()
    expect(sibling.resizedSlots).toEqual([{ unit: 2, width: 1, height: 1 }])

    // Disposing the sibling unregisters it from future shared atlas shrinks.
    sibling.resizedSlots.length = 0
    sibling.renderer.dispose()
    primary.addon.clearTextureAtlas()
    shrinkClearedWebglAtlasTextures(primary.addon)
    expect(sibling.resizedSlots).toEqual([])
  })

  it('re-acquires with 2048 via _refreshCharAtlas so sequentially attached panes share one cache entry', () => {
    type CacheEntry = {
      atlas: SharedAtlas
      config: { deviceMaxTextureSize: number }
      ownedBy: number[]
      disposed: boolean
    }
    const charAtlasCache: CacheEntry[] = []

    /** Mirror xterm CharAtlasCache.acquireTextureAtlas ownership and config matching semantics. */
    function acquireFromCache(terminalId: number, deviceMaxTextureSize: number): SharedAtlas {
      for (let i = 0; i < charAtlasCache.length; i += 1) {
        const entry = charAtlasCache[i]
        const ownedIndex = entry.ownedBy.indexOf(terminalId)
        if (ownedIndex !== -1) {
          if (entry.config.deviceMaxTextureSize === deviceMaxTextureSize) {
            return entry.atlas
          }
          if (entry.ownedBy.length === 1) {
            entry.disposed = true
            charAtlasCache.splice(i, 1)
          } else {
            entry.ownedBy.splice(ownedIndex, 1)
          }
          break
        }
      }
      for (const entry of charAtlasCache) {
        if (entry.config.deviceMaxTextureSize === deviceMaxTextureSize) {
          entry.ownedBy.push(terminalId)
          return entry.atlas
        }
      }
      const config = { deviceMaxTextureSize }
      const atlas: SharedAtlas = {
        _config: config,
        pageLayoutVersion: 0,
        pages: [{ canvas: { width: 512, height: 512 }, version: 0 }]
      }
      charAtlasCache.push({
        atlas,
        config,
        ownedBy: [terminalId],
        disposed: false
      })
      return atlas
    }

    /** Construct an addon whose renderer initially acquires with the uncapped GPU limit (16384). */
    function attachPaneWithCache(terminalId: number) {
      const glyphRenderer: {
        _atlas: SharedAtlas | undefined
        _atlasTextures: { texture: object; version: number }[]
        invalidateAtlasTextures: () => void
      } = {
        _atlas: undefined,
        _atlasTextures: [{ texture: {}, version: 1 }],
        invalidateAtlasTextures(): void {}
      }
      const renderer: {
        _deviceMaxTextureSize: number
        _charAtlas: SharedAtlas | undefined
        _glyphRenderer: { value: typeof glyphRenderer }
        _refreshCharAtlas: () => void
      } = {
        _deviceMaxTextureSize: 16384,
        _charAtlas: undefined,
        _glyphRenderer: { value: glyphRenderer },
        _refreshCharAtlas(): void {
          const nextAtlas = acquireFromCache(terminalId, this._deviceMaxTextureSize)
          this._charAtlas = nextAtlas
          glyphRenderer._atlas = nextAtlas
        }
      }
      renderer._refreshCharAtlas()
      const addon = new WebglAddon()
      Object.assign(addon, { _renderer: renderer })
      boundXtermWebglAtlasMemory(addon)
      return renderer
    }

    const firstRenderer = attachPaneWithCache(1)
    const secondRenderer = attachPaneWithCache(2)

    expect(firstRenderer._deviceMaxTextureSize).toBe(2048)
    expect(secondRenderer._deviceMaxTextureSize).toBe(2048)
    expect(charAtlasCache).toHaveLength(1)
    expect(charAtlasCache[0]?.config.deviceMaxTextureSize).toBe(2048)
    expect(charAtlasCache[0]?.ownedBy).toEqual([1, 2])
    expect(secondRenderer._charAtlas).toBe(firstRenderer._charAtlas)
  })
})
