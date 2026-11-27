// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { SETTINGS_STORAGE_KEY } from '../web-storage'
import { mergeSettings } from './web-preference-normalization'
import { getStoredSettings } from './web-preferences-store'

describe('web time format setting', () => {
  afterEach(() => {
    window.localStorage.clear()
  })

  it('keeps a saved choice across unrelated updates and normalizes invalid ones', () => {
    const saved = mergeSettings(getStoredSettings(), { timeFormat: '24h' })
    expect(mergeSettings(saved, { theme: 'dark' }).timeFormat).toBe('24h')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: simulates an untyped patch.
    const junk = { timeFormat: 'typo' } as unknown as Partial<GlobalSettings>
    expect(mergeSettings(saved, junk).timeFormat).toBe('system')
  })

  it('repairs an invalid stored value to System on load and keeps other saved settings', () => {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ timeFormat: 'typo', theme: 'dark' })
    )
    expect(getStoredSettings().timeFormat).toBe('system')
    const raw = JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}')
    expect(raw.timeFormat).toBe('system')
    expect(raw.theme).toBe('dark')
  })
})
