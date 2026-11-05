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
  const addon = new WebglAddon()
  Object.assign(addon, {
    clearTextureAtlas: () => {
      atlas.pages = [{ canvas: { width: 512, height: 512 }, version: 0 }]
      atlas.pageLayoutVersion += 1
    },
    onChangeTextureAtlas: (listener: () => void) => {
      onChangeAtlas = listener
    },
    _renderer: {
      _deviceMaxTextureSize: 16384,
      _charAtlas: atlas,
      _glyphRenderer: { value: glyphRenderer },
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
  })
  return {
    addon,
    glyphRenderer,
    textures,
    resizedSlots,
    notifyAtlasChanged: () => onChangeAtlas?.()
  }
}

describe('shared TextureAtlas sibling pane WebGL memory reclamation', () => {
  it('shrinks idle GPU texture slots in a sibling pane when beginFrame observes a shared atlas clear', () => {
    class FakeSharedTextureAtlas {
      static maxTextureSize = 16384
      _config = { deviceMaxTextureSize: 16384 }
      pageLayoutVersion = 2
      pages = [
        { canvas: { width: 2048, height: 2048 }, version: 3 },
        { canvas: { width: 2048, height: 2048 }, version: 7 },
        { canvas: { width: 2048, height: 2048 }, version: 9 }
      ]
    }
    const sharedAtlas = new FakeSharedTextureAtlas()
    const primary = createSiblingWebglAddon(sharedAtlas)
    const sibling = createSiblingWebglAddon(sharedAtlas)

    boundXtermWebglAtlasMemory(primary.addon)
    boundXtermWebglAtlasMemory(sibling.addon)
    // Re-running the atlas-change hook must not wrap beginFrame a second time.
    sibling.notifyAtlasChanged()

    primary.addon.clearTextureAtlas()
    shrinkClearedWebglAtlasTextures(primary.addon)
    expect(primary.resizedSlots).toEqual([
      { unit: 0, width: 1, height: 1 },
      { unit: 1, width: 1, height: 1 },
      { unit: 2, width: 1, height: 1 }
    ])
    expect(sibling.resizedSlots).toEqual([])

    // Sibling's first beginFrame latches the new pageLayoutVersion and must shrink idle slots 1..2.
    expect(sibling.glyphRenderer.beginFrame()).toBe(true)
    expect(sibling.textures.map((entry) => entry.version)).toEqual([-1, -1, -1])
    expect(sibling.resizedSlots).toEqual([
      { unit: 1, width: 1, height: 1 },
      { unit: 2, width: 1, height: 1 }
    ])

    // The WebglRenderer retry-loop check sees no further layout change and performs no extra shrink.
    sibling.resizedSlots.length = 0
    expect(sibling.glyphRenderer.beginFrame()).toBe(false)
    expect(sibling.resizedSlots).toEqual([])
  })
})
