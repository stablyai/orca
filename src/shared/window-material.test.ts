import { describe, expect, it } from 'vitest'
import {
  formatWindowMaterialArgument,
  parseWindowMaterialArgument,
  resolveWindowMaterial
} from './window-material'

const mac = { platform: 'darwin', osRelease: '25.0.0' } as const
const windows11 = { platform: 'win32', osRelease: '10.0.22631' } as const
const linux = { platform: 'linux', osRelease: '6.8.0' } as const

describe('resolveWindowMaterial', () => {
  it('migrates the legacy blur switch when windowMaterial is unset, except on Linux', () => {
    const legacy = { windowBackgroundBlur: true, terminalBackgroundOpacity: 0.8 }
    expect(resolveWindowMaterial(legacy, mac, false)).toBe('blur')
    expect(resolveWindowMaterial(legacy, linux, false)).toBe('off')
    expect(resolveWindowMaterial({ ...legacy, windowMaterial: 'off' }, mac, false)).toBe('off')
  })

  it('stays off while nothing translucent can reveal the material (#8482)', () => {
    for (const terminalBackgroundOpacity of [undefined, 1]) {
      expect(
        resolveWindowMaterial({ windowMaterial: 'blur', terminalBackgroundOpacity }, mac, false)
      ).toBe('off')
    }
  })

  it('turns off for Reduce Visual Effects and the OS reduced-transparency preference', () => {
    const settings = { windowMaterial: 'blur' as const, terminalBackgroundOpacity: 0.8 }
    expect(
      resolveWindowMaterial({ ...settings, reduceVisualEffects: true }, windows11, false)
    ).toBe('off')
    expect(resolveWindowMaterial(settings, windows11, true)).toBe('off')
  })

  it('maps a choice onto what the platform can render', () => {
    const translucent = { windowMaterial: 'translucent' as const, terminalBackgroundOpacity: 0.5 }
    const blur = { windowMaterial: 'blur' as const, terminalBackgroundOpacity: 0.5 }
    expect(resolveWindowMaterial(translucent, mac, false)).toBe('translucent')
    expect(resolveWindowMaterial(translucent, windows11, false)).toBe('off')
    expect(resolveWindowMaterial(blur, linux, false)).toBe('translucent')
    // Acrylic needs Windows 11 22H2; older builds would paint the clear window black.
    expect(resolveWindowMaterial(blur, { platform: 'win32', osRelease: '10.0.19045' }, false)).toBe(
      'off'
    )
  })
})

describe('window material argument', () => {
  it('round-trips and rejects unknown values', () => {
    expect(parseWindowMaterialArgument(['x', formatWindowMaterialArgument('blur')])).toBe('blur')
    expect(parseWindowMaterialArgument(['--orca-window-material=glass'])).toBe('off')
    expect(parseWindowMaterialArgument([])).toBe('off')
  })
})
