import { expect, it } from 'vitest'
import {
  normalizeNativeChatAppearanceSettings,
  resetNativeChatAppearanceSettings
} from './native-chat-appearance-settings'

it('persists only the messaging preference and clears it on appearance reset', () => {
  const saved = normalizeNativeChatAppearanceSettings({ messageStyle: 'messaging', contrast: 50 })
  expect(saved).toEqual({ messageStyle: 'messaging', contrast: 50 })
  expect(normalizeNativeChatAppearanceSettings(saved)).toEqual({
    messageStyle: 'messaging',
    contrast: 50
  })
  expect(normalizeNativeChatAppearanceSettings({ messageStyle: 'default' })).toBeUndefined()
  expect(normalizeNativeChatAppearanceSettings({ messageStyle: 'unknown' })).toBeUndefined()
  expect(resetNativeChatAppearanceSettings(saved)).toBeUndefined()
})
