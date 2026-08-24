import { useAppStore } from '@/store'

export const BROWSER_GOOGLE_COOKIE_CLEAR_SECTION_ID = 'browser-session-cookies'

export function openDefaultGoogleCookieClearSettings(): void {
  const store = useAppStore.getState()
  store.openSettingsPage()
  store.openSettingsTarget({
    pane: 'browser',
    repoId: null,
    sectionId: BROWSER_GOOGLE_COOKIE_CLEAR_SECTION_ID
  })
}
