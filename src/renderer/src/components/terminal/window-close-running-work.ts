import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { selectWorktreeHostConnectionPhase } from '@/lib/worktree-host-connection-phase'
import { selectRuntimeAwareSshTargetLabel } from '@/store/slices/runtime-environment-ssh'
import { isRemoteExecutionHostPtyId } from '../../../../shared/remote-execution-host-pty-id'
import { collectTabPtyIds } from './running-terminal-close-guard'
import { probePtyRunningWork } from './pty-running-work-probe'

/**
 * Upper bound on how long closing the window or quitting may wait on the probes.
 *
 * Shorter than the tab-close guard's 4s because quit is time-sensitive in a way one tab close is
 * not: the user has already asked to leave, and a quit that stalls on an unreachable host is its
 * own bug. A healthy local inspect answers in single-digit milliseconds and a healthy remote one
 * is a single RPC round-trip on an already-open mux channel, so this leaves roughly 3x headroom
 * over a slow-but-live transcontinental host while capping the worst case — a host that is simply
 * gone — at ~1.5s instead of the 15s RPC timeout the probe would otherwise inherit.
 *
 * Expiry raises the prompt rather than quitting silently: an unanswered probe is `unverifiable`,
 * and `unverifiable` is never evidence that remote work has stopped.
 */
export const WINDOW_CLOSE_PROBE_TIMEOUT_MS = 1_500

/** Which warning the close should raise, if any. */
export type WindowCloseRunningWork =
  /** Every pty that mattered answered, and none had children. */
  | { kind: 'none' }
  /** An owning host reported a live child process. */
  | { kind: 'running' }
  /**
   * A remote execution host could not be observed, so its work may still be live. Also names
   * any unobserved host the user disconnected themselves.
   */
  | { kind: 'unverifiable'; userDisconnectedHostLabels: string[] }
  /** Every unobserved host is one the user's own Disconnect holds down. */
  | { kind: 'user-disconnected'; hostLabels: string[] }

/**
 * Decides whether a window close or quit should stop and ask.
 *
 * Two deliberate asymmetries:
 *
 * - **Quit only considers remote ptys.** Quitting is an unambiguous instruction to end this
 *   machine's processes (#524), but it is not an instruction to end execution on someone else's:
 *   the client detaches while the relay keeps running, and a target with a bounded grace period
 *   then SIGKILLs that work once the countdown expires.
 * - **Only a remote `unverifiable` warns.** A local probe has no transport to lose, so its failure
 *   means the pty is gone. A remote one that cannot be reached is the case
 *   `docs/reference/ssh-execution-boundary.md` exists to protect: loss of contact is not evidence
 *   of `exited`, so it must fail toward asking rather than toward a silent quit.
 */
export async function assessWindowCloseRunningWork(params: {
  isQuitting: boolean
}): Promise<WindowCloseRunningWork> {
  const state = useAppStore.getState()
  const worktreeIdByPtyId = new Map<string, string>()
  for (const [worktreeId, worktreeTabs] of Object.entries(state.tabsByWorktree)) {
    for (const tab of worktreeTabs ?? []) {
      for (const ptyId of collectTabPtyIds(state, tab.id)) {
        worktreeIdByPtyId.set(ptyId, worktreeId)
      }
    }
  }
  const ptyIds = [...worktreeIdByPtyId.keys()]
  const candidatePtyIds = params.isQuitting ? ptyIds.filter(isRemoteExecutionHostPtyId) : ptyIds
  if (candidatePtyIds.length === 0) {
    return { kind: 'none' }
  }

  const probes = await probePtyRunningWork(state.settings, candidatePtyIds, {
    timeoutMs: WINDOW_CLOSE_PROBE_TIMEOUT_MS
  })
  if (probes.some((probe) => probe.verdict === 'live')) {
    return { kind: 'running' }
  }
  const unobservedWorktreeIds = new Set(
    probes
      .filter((probe) => probe.remote && probe.verdict === 'unverifiable')
      .flatMap((probe) => worktreeIdByPtyId.get(probe.ptyId) ?? [])
  )
  if (unobservedWorktreeIds.size === 0) {
    return { kind: 'none' }
  }
  return classifyUnobservedHosts(useAppStore.getState(), unobservedWorktreeIds)
}

// Why: a host the user disconnected went quiet because they asked it to, not because it was lost,
// so the prompt names it instead of calling it unreachable.
function classifyUnobservedHosts(
  state: AppState,
  worktreeIds: ReadonlySet<string>
): WindowCloseRunningWork {
  const userDisconnectedHostLabels = new Set<string>()
  let hasUnreachableHost = false
  for (const worktreeId of worktreeIds) {
    const host = selectWorktreeHostConnectionPhase(state, worktreeId)
    if (host.unavailableReason === 'user-disconnected' && host.targetId) {
      userDisconnectedHostLabels.add(
        selectRuntimeAwareSshTargetLabel(state, host.environmentId, host.targetId)
      )
    } else {
      hasUnreachableHost = true
    }
  }
  const labels = [...userDisconnectedHostLabels]
  return hasUnreachableHost
    ? { kind: 'unverifiable', userDisconnectedHostLabels: labels }
    : { kind: 'user-disconnected', hostLabels: labels }
}
