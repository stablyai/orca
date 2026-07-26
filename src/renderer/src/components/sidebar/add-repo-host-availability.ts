import type { SidebarHostOption } from './sidebar-host-options'

export function canSelectAddRepoHost(host: Pick<SidebarHostOption, 'health' | 'kind'>): boolean {
  return (
    host.health === 'local' ||
    host.health === 'available' ||
    (host.kind === 'runtime' && host.health === 'connecting')
  )
}

export function canConnectAddRepoHost(host: Pick<SidebarHostOption, 'health' | 'kind'>): boolean {
  return (
    host.kind === 'ssh' &&
    (host.health === 'disconnected' || host.health === 'error' || host.health === 'connecting')
  )
}
