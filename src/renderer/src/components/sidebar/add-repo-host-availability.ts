import type { SidebarHostOption } from './sidebar-host-options'

export function canSelectAddRepoHost(
  host: Pick<SidebarHostOption, 'health' | 'kind' | 'compatibility'>
): boolean {
  // Why: shared-control health overrides the compat verdict in the registry, so a
  // version-blocked server can read 'connecting'. Keep it unselectable regardless.
  if (host.compatibility?.kind === 'blocked') {
    return false
  }
  switch (host.health) {
    case 'local':
    case 'available':
      return true
    // Why: a runtime's 'connecting' describes only its persistent shared-control
    // channel — the status probe behind it already proved the host reachable.
    case 'connecting':
      return host.kind === 'runtime'
    case 'blocked':
    case 'disconnected':
    case 'error':
      return false
  }
}

export function canConnectAddRepoHost(host: Pick<SidebarHostOption, 'health' | 'kind'>): boolean {
  return (
    host.kind === 'ssh' &&
    (host.health === 'disconnected' || host.health === 'error' || host.health === 'connecting')
  )
}
