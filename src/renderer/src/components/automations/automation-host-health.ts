import type { SshConnectionStatus } from '../../../../shared/ssh-types'
import type {
  AutomationAuthorityHealth,
  AutomationExecutionHealth,
  AutomationHostCatalogState
} from './automation-host-catalog-types'

/** Cache-side view of an authority's list query, supplied by the caller. */
export type AutomationAuthorityQueryState = 'idle' | 'loading' | 'refreshing' | 'error'

export type AutomationAuthorityHealthInput = {
  /** The authority answered recently. Desktop is always reachable. */
  reachable: boolean
  /** False once the authority is known to lack the required list capability. */
  compatible: boolean
  queryState: AutomationAuthorityQueryState
  /** Usable rows are already cached, so a failure is *stale*, not empty. */
  hasData: boolean
}

/** Keep storage-query health independent of SSH execution connectivity; target downtime does not prevent authority listing. */
export function resolveAutomationAuthorityHealth(
  input: AutomationAuthorityHealthInput
): AutomationAuthorityHealth {
  if (!input.compatible) {
    return 'incompatible'
  }
  if (!input.reachable) {
    return 'unavailable'
  }
  if (input.queryState === 'error') {
    return 'stale-error'
  }
  if (input.queryState === 'refreshing') {
    return 'refreshing'
  }
  if (input.queryState === 'loading') {
    return input.hasData ? 'refreshing' : 'loading'
  }
  // Why: idle with nothing cached has not produced a list yet, so it is still loading.
  return input.hasData ? 'fresh' : 'loading'
}

function executionHealthForStatus(status: SshConnectionStatus): AutomationExecutionHealth {
  switch (status) {
    case 'connected':
      return 'connected'
    case 'connecting':
    case 'reconnecting':
    case 'deploying-relay':
      return 'connecting'
    case 'disconnected':
    case 'auth-failed':
    case 'reconnection-failed':
    case 'error':
      return 'disconnected'
  }
}

/** Use unknown/unavailable for unhydrated/removed registrations instead of borrowing stale connection status. */
export function resolveSshExecutionHealth(
  catalogState: AutomationHostCatalogState,
  status: SshConnectionStatus | undefined,
  missingStatus: SshConnectionStatus | undefined
): AutomationExecutionHealth {
  if (catalogState === 'removed') {
    return 'unavailable'
  }
  if (catalogState === 'unhydrated') {
    return 'unknown'
  }
  const effective = status ?? missingStatus
  return effective ? executionHealthForStatus(effective) : 'unknown'
}

/** Offline Self remains reconnectable/disconnected; unavailable is reserved for removed hosts. */
export function resolveSelfExecutionHealth(
  authorityHealth: AutomationAuthorityHealth
): AutomationExecutionHealth {
  return authorityHealth === 'unavailable' ? 'disconnected' : 'connected'
}
