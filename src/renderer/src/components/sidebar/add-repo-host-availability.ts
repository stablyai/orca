import type { SidebarHostOption } from './sidebar-host-options'

// Why not SSH rows: a project lives on the host's managed server row; an SSH row is only connected.
export function canSelectAddRepoHost(host: Pick<SidebarHostOption, 'health' | 'kind'>): boolean {
  return host.kind !== 'ssh' && (host.health === 'local' || host.health === 'available')
}

// Why WSL rows too: a WSL host's distro starts only on an explicit connect, like an SSH session.
export function canConnectAddRepoHost(
  host: Pick<SidebarHostOption, 'health' | 'kind' | 'wslDistro' | 'wslUnavailable'>
): boolean {
  return (
    (host.kind === 'ssh' || (host.wslDistro !== undefined && !host.wslUnavailable)) &&
    (host.health === 'disconnected' || host.health === 'error' || host.health === 'connecting')
  )
}
