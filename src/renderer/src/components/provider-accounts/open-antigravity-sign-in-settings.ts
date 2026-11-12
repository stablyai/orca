import { useAppStore } from '@/store'

/** Opens Settings › AI Provider Accounts › Antigravity, where the sign-in method and flow live. */
export function openAntigravitySignInSettings(): void {
  const { openSettingsTarget, openSettingsPage } = useAppStore.getState()
  openSettingsTarget({ pane: 'accounts', repoId: null, sectionId: 'accounts-antigravity' })
  openSettingsPage()
}
