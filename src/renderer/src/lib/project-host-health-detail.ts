import type { ExecutionHostHealth } from '../../../shared/execution-host/execution-host-health'

/** Why a host cannot take a project setup right now, from its health; null when health allows it. */
export function getHostHealthUnavailableDetail(health: ExecutionHostHealth): string | null {
  switch (health) {
    case 'connecting':
      return 'Connecting to host'
    case 'disconnected':
      return 'Connect this host to set up projects'
    case 'error':
      return 'Host connection needs attention'
    case 'provisioning':
      return 'VM is still provisioning'
    case 'suspended':
      return 'Resume this VM to set up projects'
    case 'waking':
      return 'VM is waking'
    case 'available':
    case 'blocked':
    case 'local':
      return null
  }
}
