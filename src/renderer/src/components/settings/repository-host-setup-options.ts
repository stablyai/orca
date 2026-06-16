import { getExecutionHostLabel, type ExecutionHostId } from '../../../../shared/execution-host'
import type { ExecutionHostRegistryEntry } from '../../../../shared/execution-host-registry'
import {
  PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
  WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import type { ProjectHostSetup, ProjectHostSetupState } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'

export type SetupHostOption = {
  id: ExecutionHostId
  label: string
  detail: string
  isAvailable: boolean
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
  return hostOptions
    .filter((host) => !setupHostIds.has(host.id))
    .map((host) => {
      const availability = getHostSetupAvailability(host)
      return {
        id: host.id,
        label: host.label || getExecutionHostLabel(host.id),
        detail: availability.detail,
        isAvailable: availability.isAvailable
      }
    })
}

function getHostSetupAvailability(host: ExecutionHostRegistryEntry): {
  isAvailable: boolean
  detail: string
} {
  if (host.health === 'blocked') {
    return {
      isAvailable: false,
      detail: translate(
        'auto.components.settings.RepositoryPane.hostSetupBlockedVersion',
        'Orca server version is incompatible'
      )
    }
  }
  if (host.kind === 'runtime') {
    const capabilities = host.capabilities
    if (!capabilities) {
      return {
        isAvailable: false,
        detail: translate(
          'auto.components.settings.RepositoryPane.hostSetupCheckingCapability',
          'Checking host capabilities'
        )
      }
    }
    if (
      !capabilities.includes(PROJECT_HOST_SETUP_RUNTIME_CAPABILITY) ||
      !capabilities.includes(WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY)
    ) {
      return {
        isAvailable: false,
        detail: translate(
          'auto.components.settings.RepositoryPane.hostSetupMissingCapability',
          'Update Orca on this host to set up projects'
        )
      }
    }
  }
  return {
    isAvailable: true,
    detail: host.detail
  }
}
