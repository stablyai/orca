// Account enrollment stays in the existing provider services and never changes selection here.
import { useAppStore } from '@/store'
import type { ProfileAgent } from '../../../../shared/agent-launch-profile'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
export type ProfileAccountOption = { id: string; email: string }
export function profileAccounts(
  settings: GlobalSettings,
  agent: ProfileAgent
): ProfileAccountOption[] {
  return agent === 'claude'
    ? settings.claudeManagedAccounts.filter((account) => account.managedAuthRuntime !== 'wsl')
    : settings.codexManagedAccounts.filter((account) => account.managedHomeRuntime !== 'wsl')
}
export async function signInProfileAccount(agent: ProfileAgent): Promise<ProfileAccountOption[]> {
  const accounts =
    agent === 'claude'
      ? (await window.api.claudeAccounts.add({ runtime: 'host' })).accounts.filter(
          (account) => account.managedAuthRuntime !== 'wsl'
        )
      : (await window.api.codexAccounts.add({ runtime: 'host', activate: false })).accounts.filter(
          (account) => account.managedHomeRuntime !== 'wsl'
        )
  // Registration belongs to Accounts even after the opening form has been dismissed.
  await useAppStore.getState().fetchSettings()
  return accounts
}
export function cancelProfileSignIn(agent: ProfileAgent): Promise<boolean> {
  return agent === 'claude'
    ? window.api.claudeAccounts.cancelPendingLogin()
    : window.api.codexAccounts.cancelPendingLogin()
}
