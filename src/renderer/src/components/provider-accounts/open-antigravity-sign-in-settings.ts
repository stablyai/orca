import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

/** Opens Settings › AI Provider Accounts › Antigravity on the chat's host, where sign-in lives. */
export function openAntigravitySignInSettings(host: RuntimeClientTarget | undefined): void {
  const { openSettingsTarget, openSettingsPage } = useAppStore.getState()
  openSettingsTarget({
    pane: 'accounts',
    repoId: null,
    sectionId: 'accounts-antigravity',
    ...(host ? { hostScope: host, intent: 'native-accounts' as const } : {})
  })
  openSettingsPage()
}
