import type { SidebarHostOption } from './sidebar-host-options'

// Projects belong to managed-server rows; a connected SSH row alone cannot host one.
export function canSelectAddRepoHost(host: Pick<SidebarHostOption, 'health' | 'kind'>): boolean {
  return host.kind !== 'ssh' && (host.health === 'local' || host.health === 'available')
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
