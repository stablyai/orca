// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { SETTINGS_STORAGE_KEY, UI_STORAGE_KEY } from '../web-storage'
import { getStoredSettings, writeStoredSettings } from './web-preferences-store'

let setItemSpy: MockInstance<Storage['setItem']> | null = null

// Why: vi.restoreAllMocks cannot delete a spy from happy-dom's Storage proxy; mockRestore can.
function denyStorageWrites(denied: (key: string) => boolean): void {
  const setItem = window.localStorage.setItem.bind(window.localStorage)
  setItemSpy = vi.spyOn(window.localStorage, 'setItem').mockImplementation((key, value) => {
    if (denied(key)) {
      throw new DOMException('Storage is full', 'QuotaExceededError')
    }
    setItem(key, value)
  })
}

describe('web app rail default cohort', () => {
  afterEach(() => {
    setItemSpy?.mockRestore()
    setItemSpy = null
    window.localStorage.clear()
  })

  it('defaults on for a new browser and preserves the default when other settings save', () => {
    const fresh = getStoredSettings()
    expect(fresh.experimentalAppRail).toBe(true)

    writeStoredSettings({ ...fresh, theme: 'dark' })
    expect(getStoredSettings().experimentalAppRail).toBe(true)
  })

  it('stays off for an existing browser without a saved choice and keeps explicit opt-in', () => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ theme: 'dark' }))
    expect(getStoredSettings().experimentalAppRail).toBe(false)
    expect(JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}')).toMatchObject({
      experimentalAppRail: false
    })

    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ theme: 'dark', experimentalAppRail: true })
    )
    expect(getStoredSettings().experimentalAppRail).toBe(true)
  })

  it('returns readable existing settings when the migration write is denied', () => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ theme: 'dark' }))
    denyStorageWrites(() => true)

    const settings = getStoredSettings()

    expect(settings.theme).toBe('dark')
    expect(settings.experimentalAppRail).toBe(false)
    expect(JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}')).toEqual({
      theme: 'dark'
    })
  })

  it('returns migrated settings when only the OSC 52 notice write is denied', () => {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ theme: 'dark', terminalAllowOsc52Clipboard: false })
    )
    denyStorageWrites((key) => key === UI_STORAGE_KEY)

    const settings = getStoredSettings()

    expect(settings.theme).toBe('dark')
    expect(settings.experimentalAppRail).toBe(false)
    expect(window.localStorage.getItem(UI_STORAGE_KEY)).toBeNull()
  })
})
