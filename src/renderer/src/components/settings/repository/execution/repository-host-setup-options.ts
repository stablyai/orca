import {
  getExecutionHostLabel,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { ExecutionHostRegistryEntry } from '../../../../../../shared/execution-host/execution-host-registry-entry'
import type {
  ProjectHostSetup,
  ProjectHostSetupState
} from '../../../../../../shared/project-types'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { getHostSetupUnavailableDetail } from '@/lib/project-host-setup-options'
import { pickerExecutionHosts } from '../../../../../../shared/execution-host/managed-orcad-execution-host'

export type SetupHostOption = {
  id: ExecutionHostId
  label: string
  detail: string
  isAvailable: boolean
  canUsePathActions: boolean
}

export function getSetupStateLabel(
  setupState: ProjectHostSetupState,
  t: Translate = translate
): string {
  switch (setupState) {
    case 'ready':
      return t('auto.components.settings.RepositoryPane.hostSetupStateReady', 'Ready')
    case 'not-set-up':
      return t('auto.components.settings.RepositoryPane.hostSetupStateNotSetUp', 'Not set up')
    case 'setting-up':
      return t('auto.components.settings.RepositoryPane.hostSetupStateSettingUp', 'Setting up')
    case 'error':
      return t('auto.components.settings.RepositoryPane.hostSetupStateError', 'Error')
    case 'unsupported':
      return t('auto.components.settings.RepositoryPane.hostSetupStateUnsupported', 'Unsupported')
  }
}

export function buildSetupHostOptions(
  {
    projectHostSetups,
    hostOptions
  }: {
    projectHostSetups: ProjectHostSetup[]
    hostOptions: readonly ExecutionHostRegistryEntry[]
  },
  t: Translate = translate
): SetupHostOption[] {
  const setupHostIds = new Set(projectHostSetups.map((setup) => setup.hostId))
  return pickerExecutionHosts(hostOptions)
    .filter(
      (host) =>
        !setupHostIds.has(host.id) &&
        // Host aliases name one machine; do not offer setup again under another ID.
        !host.aliasHostIds?.some((aliasHostId) => setupHostIds.has(aliasHostId))
    )
    .map((host) => {
      const unavailableDetail = getHostSetupUnavailableDetail(host, t)
      // Offline hosts can be placeholders; clone/import require live providers.
      const canUsePathActions = host.health === 'local' || host.health === 'available'
      return {
        id: host.id,
        label: host.label || getExecutionHostLabel(host.id),
        detail:
          unavailableDetail ??
          (canUsePathActions
            ? host.detail
            : t(
                'auto.components.settings.RepositoryPane.hostSetupConnectionRequired',
                'Connect this host before importing or cloning the project'
              )),
        isAvailable: unavailableDetail === null,
        canUsePathActions
      }
    })
}
