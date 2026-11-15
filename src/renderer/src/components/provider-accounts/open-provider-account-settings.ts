import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'

export function openProviderAccountSettings(
  agent: string,
  host: RuntimeClientTarget | undefined
): void {
  const { openSettingsTarget, openSettingsPage } = useAppStore.getState()
  openSettingsTarget({
    pane: 'accounts',
    repoId: null,
    sectionId: `accounts-${agent}`,
    ...(host ? { hostScope: host, intent: 'native-accounts' as const } : {})
  })
  openSettingsPage()
}
