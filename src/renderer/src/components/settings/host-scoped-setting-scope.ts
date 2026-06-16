import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import type { SidebarHostOption } from '../sidebar/sidebar-host-options'

/** Sentinel scope for "edit the shared client default" rather than a host override. */
export const CLIENT_DEFAULT_SCOPE = 'client-default'

export type HostSettingScope = typeof CLIENT_DEFAULT_SCOPE | ExecutionHostId

export type HostScopeChoice = {
  scope: HostSettingScope
  label: string
}

/** Builds the "Apply to:" choices: the client default first, then every known
 *  non-local host. Local is excluded because its override and the client
 *  default address the same machine. */
export function buildHostScopeChoices(
  hosts: readonly SidebarHostOption[],
  clientDefaultLabel: string
): HostScopeChoice[] {
  const choices: HostScopeChoice[] = [{ scope: CLIENT_DEFAULT_SCOPE, label: clientDefaultLabel }]
  for (const host of hosts) {
    if (host.id !== LOCAL_EXECUTION_HOST_ID) {
      choices.push({ scope: host.id, label: host.label })
    }
  }
  return choices
}

/** A scope is host-specific when it targets a real host rather than the shared default. */
export function isHostScope(scope: HostSettingScope): scope is ExecutionHostId {
  return scope !== CLIENT_DEFAULT_SCOPE
}
