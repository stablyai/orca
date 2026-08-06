import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  measureDivergence,
  releaseRenderDesyncReadback,
  type BufferLike,
  type SentinelRenderInternals
} from './terminal-render-desync-frame'

const rendererState = {
  atlasPages: 1,
  atlasClearModelGeneration: 0,
  atlasPageVersions: [0],
  glyphLastSeenClearModelGeneration: 0,
  glyphTextureVersions: [0],
  modelLineLengths: [1],
  vertexCount: 1,
  activeVertexBuffer: 0
}

const buffer: BufferLike = {
  cursorY: 1,
  viewportY: 0,
  getLine: () => ({
    getCell: () => ({ getChars: () => 'x', getWidth: () => 1 }),
    translateToString: () => 'x'
  })
}

afterEach(() => {
  releaseRenderDesyncReadback()
  vi.unstubAllGlobals()
})

describe('measureDivergence', () => {
  it.each([
    { name: 'dark', background: [0, 0, 0] as const, ink: [255, 255, 255] as const },
    { name: 'light', background: [255, 255, 255] as const, ink: [0, 0, 0] as const }
  ])('detects missing and rendered cells against a $name theme', ({ background, ink }) => {
    const pixels = new Uint8ClampedArray(4 * 4 * 4)
    for (let index = 0; index < pixels.length; index += 4) {
      pixels[index] = background[0]
      pixels[index + 1] = background[1]
      pixels[index + 2] = background[2]
      pixels[index + 3] = 255
    }
    const context = {
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: pixels }))
    }
    const createElement = vi.fn(() => ({
      width: 0,
      height: 0,
      getContext: () => context
    }))
    vi.stubGlobal('document', { createElement })
    const internals: SentinelRenderInternals = {
      rows: 1,
      cols: 1,
      isPaused: false,
      canvas: { width: 4, height: 4 } as HTMLCanvasElement,
      cellWidth: 4,
      cellHeight: 4,
      backgroundRgb: background,
      rendererState
    }

    expect(measureDivergence(internals, buffer)?.missing).toBe(1)
    const center = (1 * 4 + 1) * 4
    pixels[center] = ink[0]
    pixels[center + 1] = ink[1]
    pixels[center + 2] = ink[2]
    expect(measureDivergence(internals, buffer)?.missing).toBe(0)
    expect(createElement).toHaveBeenCalledTimes(1)
  })
})
