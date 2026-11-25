import { useAppStateValue } from '@/store/retained-views/app-state-view'
import { useTranslate } from '@/i18n/use-translate'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

export function useWorkspaceCleanupHostName(owner: RuntimeClientTarget, localName?: string) {
  const t = useTranslate()
  const name = useAppStateValue((state) =>
    owner.kind === 'environment'
      ? state.runtimeEnvironments.find((environment) => environment.id === owner.environmentId)
          ?.name
      : localName
  )
  return name?.trim() || t('components.settings.workspaceCleanup.change.thisHost', 'this host')
}
