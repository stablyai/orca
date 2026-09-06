import { useAppStore } from '@/store'
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
  /** A remote execution host could not be observed, so its work may still be live. */
  | { kind: 'unverifiable' }

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
  const ptyIds = new Set(
    Object.values(state.tabsByWorktree)
      .flatMap((worktreeTabs) => worktreeTabs ?? [])
      .flatMap((tab) => collectTabPtyIds(state, tab.id))
  )
  const candidatePtyIds = params.isQuitting
    ? [...ptyIds].filter(isRemoteExecutionHostPtyId)
    : [...ptyIds]
  if (candidatePtyIds.length === 0) {
    return { kind: 'none' }
  }

  const probes = await probePtyRunningWork(state.settings, candidatePtyIds, {
    timeoutMs: WINDOW_CLOSE_PROBE_TIMEOUT_MS
  })
  if (probes.some((probe) => probe.verdict === 'live')) {
    return { kind: 'running' }
  }
  if (probes.some((probe) => probe.remote && probe.verdict === 'unverifiable')) {
    return { kind: 'unverifiable' }
  }
  return { kind: 'none' }
}
