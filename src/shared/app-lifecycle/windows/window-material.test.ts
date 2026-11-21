import { describe, expect, it } from 'vitest'
import {
  formatWindowMaterialArgument,
  parseWindowMaterialArgument,
  resolveWindowMaterial
} from './window-material'

describe('Frosted Glass window material', () => {
  const settings = { windowMaterial: 'frosted', terminalBackgroundOpacity: 0.2 } as const
  const macOS15 = { platform: 'darwin', osRelease: '24.6.0' } as const

  it('preserves the resolved material from window creation to the renderer', () => {
    const material = resolveWindowMaterial(settings, macOS15, false)
    expect(parseWindowMaterialArgument([formatWindowMaterialArgument(material)])).toBe('frosted')
  })

  it('uses the host’s normal blur fallback where Frosted Glass is unavailable', () => {
    expect(resolveWindowMaterial(settings, { ...macOS15, osRelease: '25.0.0' }, false)).toBe('blur')
    expect(
      resolveWindowMaterial(settings, { platform: 'win32', osRelease: '10.0.22631' }, false)
    ).toBe('blur')
    expect(resolveWindowMaterial(settings, { platform: 'linux', osRelease: '6.1.0' }, false)).toBe(
      'translucent'
    )
    expect(
      resolveWindowMaterial(settings, { platform: 'win32', osRelease: '10.0.19045' }, false)
    ).toBe('off')
  })

  it('respects reduced transparency and does not compose glass behind fully opaque surfaces', () => {
    expect(resolveWindowMaterial(settings, macOS15, true)).toBe('off')
    expect(resolveWindowMaterial({ ...settings, reduceVisualEffects: true }, macOS15, false)).toBe(
      'off'
    )
    expect(
      resolveWindowMaterial({ ...settings, terminalBackgroundOpacity: 1 }, macOS15, false)
    ).toBe('off')
  })
})
