import type { SshConnectionStatus } from '../../../../shared/ssh-types'
import { boundHostList, type BoundedHostList } from '../host-picker/bounded-host-list'

// Bound idle hosts because generated SSH configs can turn thousands of rows into gigabytes of DOM.
export const SSH_STATUS_MENU_IDLE_ROW_LIMIT = 25

export type SshStatusMenuTarget = { id: string; label: string; status: SshConnectionStatus }

export type SshStatusMenuRows = {
  connected: SshStatusMenuTarget[]
  inactive: SshStatusMenuTarget[]
  hiddenIdleCount: number
}

/** Always show busy/connected hosts; above the idle limit, prioritize hosts with projects over config order. */
export function splitSshStatusMenuRows(
  targets: readonly SshStatusMenuTarget[],
  options: { projectHostIds?: ReadonlySet<string>; idleRowLimit?: number } = {}
): SshStatusMenuRows {
  const { projectHostIds, idleRowLimit = SSH_STATUS_MENU_IDLE_ROW_LIMIT } = options
  const connected = targets.filter((target) => target.status === 'connected')
  const inactive = targets.filter((target) => target.status !== 'connected')
  const idle = inactive.filter((target) => target.status === 'disconnected')
  if (idle.length <= idleRowLimit) {
    return { connected, inactive, hiddenIdleCount: 0 }
  }
  const busy = inactive.filter((target) => target.status !== 'disconnected')
  const shownIdle = [
    ...idle.filter((target) => projectHostIds?.has(target.id)),
    ...idle.filter((target) => !projectHostIds?.has(target.id))
  ].slice(0, idleRowLimit)
  return {
    connected,
    inactive: [...busy, ...shownIdle],
    hiddenIdleCount: idle.length - shownIdle.length
  }
}

export function findSshHostMatches(
  targets: readonly SshStatusMenuTarget[],
  query: string,
  limit?: number
): BoundedHostList<SshStatusMenuTarget> {
  return boundHostList(
    targets.filter((target) => target.status !== 'connected'),
    { query, limit }
  )
}
