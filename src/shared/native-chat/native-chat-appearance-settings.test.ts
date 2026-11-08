import { describe, expect, it } from 'vitest'
import {
  normalizeNativeChatAppearanceSettings,
  resetNativeChatAppearanceSettings
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
  it('resets known controls while keeping settings from a newer version', () => {
    const fromNewerVersion = {
      fontFamily: 'Georgia',
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
})
