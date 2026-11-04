import type { SidebarHostOption } from '../../sidebar-host-options'

export function canSelectAddRepoHost(
  host: Pick<SidebarHostOption, 'health' | 'kind' | 'compatibility'>
): boolean {
  // Projects require a managed server; compatibility can be blocked even while control connects.
  if (host.kind === 'ssh' || host.compatibility?.kind === 'blocked') {
    return false
  }
  switch (host.health) {
    case 'local':
    case 'available':
      return true
    case 'connecting':
    case 'blocked':
    case 'disconnected':
    case 'error':
      return false
  }
}

// WSL starts only on explicit connect, matching SSH connection intent.
export function canConnectAddRepoHost(
  host: Pick<SidebarHostOption, 'health' | 'kind' | 'wslDistro' | 'wslUnavailable'>
): boolean {
  return (
    (host.kind === 'ssh' || (host.wslDistro !== undefined && !host.wslUnavailable)) &&
    (host.health === 'disconnected' || host.health === 'error' || host.health === 'connecting')
  )
}
