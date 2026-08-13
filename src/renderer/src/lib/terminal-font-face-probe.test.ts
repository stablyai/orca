import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearTerminalFontFaceProbeCache, probeTerminalFontFaces } from './terminal-font-face-probe'

afterEach(() => {
  clearTerminalFontFaceProbeCache()
  vi.unstubAllGlobals()
})

describe('probeTerminalFontFaces', () => {
  it('returns no faces when canvas rasters are empty', () => {
    expect(probeTerminalFontFaces('Menlo')).toEqual([])
  })

  it('clusters two-state canvas rasters into regular and bold faces', () => {
    vi.stubGlobal('document', {
      createElement: () => {
        let currentWeight = 400
        return {
          width: 0,
          height: 0,
          getContext: () => ({
            fillStyle: '',
            textBaseline: '',
            set font(value: string) {
              currentWeight = Number(String(value).split(' ')[0])
            },
            fillRect: () => undefined,
            fillText: () => undefined,
            measureText: () => ({ width: 354.0059 }),
            getImageData: () => {
              const ink = currentWeight < 600 ? 10 : 20
              const data = new Uint8ClampedArray(ink * 4)
              for (let index = 0; index < data.length; index += 4) {
                data[index] = 255
              }
              return { data }
            }
          })
        }
      }
    })

    expect(probeTerminalFontFaces('"SF Mono", "Menlo", monospace')).toEqual([400, 700])
  })
})
