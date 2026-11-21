import { describe, expect, it } from 'vitest'
import {
  normalizeNativeChatAppearanceSettings,
  resetNativeChatAppearanceSettings
} from './native-chat-appearance-settings'

const FILE = '0b7c2f1e-3d4a-4b5c-9d8e-7f6a5b4c3d2e.jpg'

describe('chat background and glass message settings', () => {
  it('keeps a picked background, clamps its visibility and keeps glass on', () => {
    expect(
      normalizeNativeChatAppearanceSettings({
        backgroundImage: FILE,
        backgroundVisibility: 2,
        glassMessages: true
      })
    ).toEqual({ backgroundImage: FILE, backgroundVisibility: 10, glassMessages: true })
  })

  it('drops background names that are not main-generated files', () => {
    for (const backgroundImage of ['../secret.png', `${FILE}/../x.png`, 'image.svg', 'a.png']) {
      expect(normalizeNativeChatAppearanceSettings({ backgroundImage })).toBeUndefined()
    }
  })

  it('stores nothing for default values and reset clears the background', () => {
    expect(
      normalizeNativeChatAppearanceSettings({
        backgroundVisibility: 40,
        glassMessages: false
      })
    ).toBeUndefined()
    expect(
      resetNativeChatAppearanceSettings({ backgroundImage: FILE, fontSize: 16 })
    ).toBeUndefined()
  })
})
