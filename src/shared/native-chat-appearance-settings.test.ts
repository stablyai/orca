import { describe, expect, it } from 'vitest'
import {
  normalizeNativeChatAppearanceSettings,
  resetNativeChatAppearanceSettings,
  resolveNativeChatAppearanceSettings
} from './native-chat-appearance-settings'

describe('native chat appearance normalization', () => {
  it('preserves unknown future fields while normalizing only known fields', () => {
    const future = {
      futureSetting: { nested: 'keep' }
    }
    expect(
      normalizeNativeChatAppearanceSettings({
        ...future,
        contrast: 151,
        matchTerminalInterface: true,
        fontSize: 99,
        codeFontSize: 12,
        width: 'comfortable'
      })
    ).toEqual({ ...future, fontSize: 20, contrast: 150, matchTerminalInterface: true })
    expect(normalizeNativeChatAppearanceSettings(future)).toEqual(future)
  })

  it('preserves future fields without letting known defaults or malformed values survive', () => {
    const future = { futureSetting: { nested: 'keep' } }
    for (const contrast of [100, Number.NaN, Number.POSITIVE_INFINITY, '150', null]) {
      for (const matchTerminalInterface of [false, 'true', null]) {
        expect(
          normalizeNativeChatAppearanceSettings({
            ...future,
            contrast,
            matchTerminalInterface
          })
        ).toEqual(future)
      }
    }
  })

  it('derives defaults without storing them', () => {
    expect(
      normalizeNativeChatAppearanceSettings({
        fontSize: 14,
        codeFontSize: 12,
        width: 'comfortable'
      })
    ).toBeUndefined()
    expect(resolveNativeChatAppearanceSettings(undefined)).toEqual({
      fontSize: 14,
      codeFontSize: 12,
      width: 'comfortable',
      contrast: 100,
      matchTerminalInterface: false
    })
  })
  it('resets all five known controls while keeping settings from a newer version', () => {
    const fromNewerVersion = {
      fontSize: 18,
      codeFontSize: 16,
      width: 'wide' as const,
      contrast: 151,
      matchTerminalInterface: true,
      futureSetting: { nested: 'keep' }
    }
    expect(resetNativeChatAppearanceSettings(fromNewerVersion)).toEqual({
      futureSetting: { nested: 'keep' }
    })
    expect(resetNativeChatAppearanceSettings({ fontSize: 18 })).toBeUndefined()
  })
  it('clamps and rounds values on read', () => {
    expect(
      resolveNativeChatAppearanceSettings({ fontSize: 99, codeFontSize: 0, width: 'full' })
    ).toEqual({
      fontSize: 20,
      codeFontSize: 10,
      width: 'full',
      contrast: 100,
      matchTerminalInterface: false
    })
    expect(
      normalizeNativeChatAppearanceSettings({ fontSize: 15.6, codeFontSize: 13.2, width: 'wide' })
    ).toEqual({ fontSize: 16, codeFontSize: 13, width: 'wide' })
  })
  it('falls back safely for malformed persisted data', () => {
    for (const value of [
      null,
      false,
      'large',
      {},
      { fontSize: Number.NaN, codeFontSize: Number.POSITIVE_INFINITY, width: 'giant' },
      { fontSize: '20' }
    ]) {
      expect(normalizeNativeChatAppearanceSettings(value)).toBeUndefined()
    }
  })
})

describe('chat contrast and terminal interface normalization', () => {
  it('removes default fields and the empty object', () => {
    expect(
      normalizeNativeChatAppearanceSettings({ contrast: 100, matchTerminalInterface: false })
    ).toBeUndefined()
    expect(
      normalizeNativeChatAppearanceSettings({
        fontSize: 16,
        contrast: 100,
        matchTerminalInterface: false
      })
    ).toEqual({ fontSize: 16 })
    expect(
      normalizeNativeChatAppearanceSettings({
        codeFontSize: 13,
        contrast: 120,
        matchTerminalInterface: true
      })
    ).toEqual({ codeFontSize: 13, contrast: 120, matchTerminalInterface: true })
  })

  it('clamps and rounds persisted contrast, accepting only an explicit true toggle', () => {
    expect(
      resolveNativeChatAppearanceSettings({ contrast: 999, matchTerminalInterface: 'true' })
    ).toMatchObject({ contrast: 150, matchTerminalInterface: false })
    expect(normalizeNativeChatAppearanceSettings({ contrast: -5 })).toEqual({ contrast: 50 })
    expect(normalizeNativeChatAppearanceSettings({ contrast: 120.6 })).toEqual({ contrast: 121 })
    for (const contrast of [Number.NaN, Number.POSITIVE_INFINITY, '150', null]) {
      expect(normalizeNativeChatAppearanceSettings({ contrast })).toBeUndefined()
    }
  })
})
