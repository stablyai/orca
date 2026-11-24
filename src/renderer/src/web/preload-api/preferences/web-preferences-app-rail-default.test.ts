// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { SETTINGS_STORAGE_KEY } from '../web-storage'
import { getStoredSettings, writeStoredSettings } from './web-preferences-store'

describe('web app rail default cohort', () => {
  afterEach(() => {
    vi.restoreAllMocks()
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
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage is full', 'QuotaExceededError')
    })

    const settings = getStoredSettings()

    expect(settings.theme).toBe('dark')
    expect(settings.experimentalAppRail).toBe(false)
    expect(JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}')).toEqual({
      theme: 'dark'
    })
  })
})
