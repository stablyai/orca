import type { ExecutionHostRegistryEntry } from '../../../shared/execution-host/execution-host-registry-entry'
import type { ProjectHostSetup } from '../../../shared/project-types'

export function getHostHealthUnavailableDetail(
  health: ExecutionHostRegistryEntry['health']
): string | null {
  switch (health) {
    case 'connecting':
      return 'Connecting to host'
    case 'disconnected':
      return 'Connect this host to set up projects'
    case 'error':
      return 'Host connection needs attention'
    case 'available':
    case 'blocked':
    case 'local':
      return null
  }
}

export function getPendingSetupDetail(setup: ProjectHostSetup): string {
  switch (setup.setupState) {
    case 'not-set-up':
      return 'Project tracked on this host but not set up'
    case 'setting-up':
      return 'Project setup is in progress'
    case 'error':
      return 'Project setup needs attention'
    case 'unsupported':
      return 'Project is unsupported on this host'
    case 'ready':
      return setup.path
  }
}
