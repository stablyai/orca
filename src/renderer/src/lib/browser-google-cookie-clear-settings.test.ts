import { describe, expect, it, vi } from 'vitest'

const { openSettingsPage, openSettingsTarget } = vi.hoisted(() => ({
  openSettingsPage: vi.fn(),
  openSettingsTarget: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ openSettingsPage, openSettingsTarget })
  }
}))

import {
  BROWSER_GOOGLE_COOKIE_CLEAR_SECTION_ID,
  openDefaultGoogleCookieClearSettings
} from './browser-google-cookie-clear-settings'

describe('openDefaultGoogleCookieClearSettings', () => {
  it('opens Settings to Session & Cookies', () => {
    openDefaultGoogleCookieClearSettings()

    expect(openSettingsPage).toHaveBeenCalledOnce()
    expect(openSettingsTarget).toHaveBeenCalledWith({
      pane: 'browser',
      repoId: null,
      sectionId: BROWSER_GOOGLE_COOKIE_CLEAR_SECTION_ID
    })
    expect(BROWSER_GOOGLE_COOKIE_CLEAR_SECTION_ID).toBe('browser-session-cookies')
  })
})
