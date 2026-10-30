/**
 * E9: forge (PR/review) refreshes for a workspace on a WSL host go through the host, which never
 * boots a stopped distro for a poll. Skip them while the host is off and say so, rather than
 * failing a request per badge. Connecting, reconnecting or unverifiable hosts are not off: their
 * calls proceed (or fail) as usual.
 */
import { isWslHostRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { WslHostStatus } from '../../../../shared/wsl-host-types'
import type { AppState } from '../types'
import type { PRRefreshState } from './pr-refresh-state'

export function isWslHostOffForForge(
  // Partial: narrowed store snapshots may omit either slice.
  state: Partial<Pick<AppState, 'runtimeEnvironments' | 'wslHostStatuses'>>,
  environmentId: string
): boolean {
  const environment = state.runtimeEnvironments?.find((entry) => entry.id === environmentId)
  return Boolean(
    environment &&
    isWslHostRuntimeEnvironment(environment) &&
    isOffState(state.wslHostStatuses?.[environmentId]?.state)
  )
}

/** Confirmed stopped (a parked host included), or WSL hosts closed: nothing will answer. */
function isOffState(state: WslHostStatus['state'] | undefined): boolean {
  return state === 'distro-stopped' || state === 'closed'
}

/** Records the skip, so the Checks panel says the host is off instead of showing stale status. */
export function withForgeHostOffSkip(
  states: Record<string, PRRefreshState>,
  cacheKey: string
): { prRefreshStates: Record<string, PRRefreshState> } {
  return {
    prRefreshStates: {
      ...states,
      [cacheKey]: {
        status: 'skipped',
        reason: 'swr',
        skippedReason: 'host-off',
        updatedAt: Date.now()
      }
    }
  }
}
