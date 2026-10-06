import { describe, expect, it } from 'vitest'
import {
  normalizeNativeChatAppearanceSettings,
  resetNativeChatAppearanceSettings,
  resolveNativeChatAppearanceSettings
} from './native-chat-appearance-settings'

describe('native chat appearance normalization', () => {
  it('preserves unknown future fields while normalizing only known fields', () => {
    const future = {
      contrast: 151,
      matchTerminalInterface: true,
      futureSetting: { nested: 'keep' }
    }
    expect(
      normalizeNativeChatAppearanceSettings({
        ...future,
        fontSize: 99,
        codeFontSize: 12,
        width: 'comfortable'
      })
    ).toEqual({ ...future, fontSize: 20 })
    expect(normalizeNativeChatAppearanceSettings(future)).toEqual(future)
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
      width: 'comfortable'
    })
  })
  it('resets only known controls while keeping settings from a newer version', () => {
    const fromNewerVersion = {
      fontSize: 18,
      codeFontSize: 16,
      width: 'wide' as const,
      contrast: 151,
      matchTerminalInterface: true
    }
    expect(resetNativeChatAppearanceSettings(fromNewerVersion)).toEqual({
      contrast: 151,
      matchTerminalInterface: true
    })
    expect(resetNativeChatAppearanceSettings({ fontSize: 18 })).toBeUndefined()
  })
  it('clamps and rounds values on read', () => {
    expect(
      resolveNativeChatAppearanceSettings({ fontSize: 99, codeFontSize: 0, width: 'full' })
    ).toEqual({ fontSize: 20, codeFontSize: 10, width: 'full' })
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
  it('keeps typed text colors and applies only valid hex per theme', () => {
    expect(
      normalizeNativeChatAppearanceSettings({ textColorLight: ' #12', textColorDark: '' })
    ).toEqual({ textColorLight: '#12' })
    expect(
      resolveNativeChatAppearanceSettings({ textColorLight: '#12', textColorDark: 'a0b1c2' })
    ).toMatchObject({ textColorLight: undefined, textColorDark: '#a0b1c2' })
    expect(
      resolveNativeChatAppearanceSettings({
        userBubbleColorDark: '#334455',
        userBubbleColorLight: 'x'
      })
    ).toMatchObject({ userBubbleColorDark: '#334455', userBubbleColorLight: undefined })
    const fromNewerVersion = { textColorLight: '#fff', userBubbleColorDark: '#000', contrast: 120 }
    expect(resetNativeChatAppearanceSettings(fromNewerVersion)).toEqual({ contrast: 120 })
  })
})
