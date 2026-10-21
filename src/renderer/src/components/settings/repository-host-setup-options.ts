import { getExecutionHostLabel, type ExecutionHostId } from '../../../../shared/execution-host'
import type { ExecutionHostRegistryEntry } from '../../../../shared/execution-host-registry'
import type { ProjectHostSetup, ProjectHostSetupState } from '../../../../shared/project-types'
import { translate } from '@/i18n/i18n'
import { getHostSetupUnavailableDetail } from '@/lib/project-host-setup-options'
import { pickerExecutionHosts } from '../../../../shared/managed-orcad-execution-host'

export type SetupHostOption = {
  id: ExecutionHostId
  label: string
  detail: string
  isAvailable: boolean
  canUsePathActions: boolean
}

export function getSetupStateLabel(setupState: ProjectHostSetupState): string {
  switch (setupState) {
    case 'ready':
      return translate('auto.components.settings.RepositoryPane.hostSetupStateReady', 'Ready')
    case 'not-set-up':
      return translate(
        'auto.components.settings.RepositoryPane.hostSetupStateNotSetUp',
        'Not set up'
      )
    case 'setting-up':
      return translate(
        'auto.components.settings.RepositoryPane.hostSetupStateSettingUp',
        'Setting up'
      )
    case 'error':
      return translate('auto.components.settings.RepositoryPane.hostSetupStateError', 'Error')
    case 'unsupported':
      return translate(
        'auto.components.settings.RepositoryPane.hostSetupStateUnsupported',
        'Unsupported'
      )
  }
}

export function buildSetupHostOptions({
  projectHostSetups,
  hostOptions
}: {
  projectHostSetups: ProjectHostSetup[]
  hostOptions: readonly ExecutionHostRegistryEntry[]
}): SetupHostOption[] {
  const setupHostIds = new Set(projectHostSetups.map((setup) => setup.hostId))
  return pickerExecutionHosts(hostOptions)
    .filter(
      (host) =>
        !setupHostIds.has(host.id) &&
        // Why: one machine; the project already set up under its other id needs no second offer.
        !host.aliasHostIds?.some((aliasHostId) => setupHostIds.has(aliasHostId))
    )
    .map((host) => {
      const unavailableDetail = getHostSetupUnavailableDetail(host)
      // Why: import and clone require live remote providers, while an offline
      // host can still be recorded as a placeholder for later setup.
      const canUsePathActions = host.health === 'local' || host.health === 'available'
      return {
        id: host.id,
        label: host.label || getExecutionHostLabel(host.id),
        detail:
          unavailableDetail ??
          (canUsePathActions
            ? host.detail
            : translate(
                'auto.components.settings.RepositoryPane.hostSetupConnectionRequired',
                'Connect this host before importing or cloning the project'
              )),
        isAvailable: unavailableDetail === null,
        canUsePathActions
      }
    })
}
