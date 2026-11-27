// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { SETTINGS_STORAGE_KEY } from '../web-storage'
import { getStoredSettings, writeStoredSettings } from './web-preferences-store'

describe('web composer details default cohort', () => {
  afterEach(() => window.localStorage.clear())

  it('starts off for a new browser and stays on for an existing one without a choice', () => {
    const fresh = getStoredSettings()
    expect(fresh.nativeChatComposerDetails).toBe(false)
    writeStoredSettings({ ...fresh, theme: 'dark' })
    expect(getStoredSettings().nativeChatComposerDetails).toBe(false)

    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ theme: 'dark' }))
    expect(getStoredSettings().nativeChatComposerDetails).toBe(true)
    expect(JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}')).toMatchObject({
      nativeChatComposerDetails: true
    })

    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ theme: 'dark', nativeChatComposerDetails: false })
    )
    expect(getStoredSettings().nativeChatComposerDetails).toBe(false)
  })
})
