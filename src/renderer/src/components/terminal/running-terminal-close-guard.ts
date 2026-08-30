import { useAppStore } from '@/store'
import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'
import { useRunningTerminalCloseConfirmStore } from '@/store/running-terminal-close-confirm'
import type { TerminalTabCloseReason } from '@/store/slices/terminal-tab-retirement'
import type { AppState } from '@/store/types'
import { resolveBusyPtyCloseCopyKind } from './terminal-close-copy-kind'

export type RunningTerminalCloseGuardOptions = {
  force?: boolean
  rejectPinned?: boolean
  reason?: TerminalTabCloseReason
  hostCloseReason?: TerminalTabCloseReason
  lifecyclePtyId?: string
  skipRunningProcessConfirm?: boolean
}

/** Upper bound on how long a close may wait on the probe before it asks instead. A remote
 *  inspect RPC can hang for its full 15s timeout, and an X button that looks dead for 15s
 *  is the same class of bug as one that never asks — but an unanswered probe is not
 *  evidence of an idle shell, so the timeout raises the prompt rather than killing a
 *  possibly-running remote command (#10142). */
export const RUNNING_CLOSE_PROBE_TIMEOUT_MS = 4_000

/** Whether this close is an interactive user action that should stop and ask before
 *  killing a live child process. Lifecycle echoes, bulk closes, CLI/RPC closes and the
 *  post-confirmation re-entry are all excluded. */
export function shouldConfirmRunningTerminalClose(
  options?: RunningTerminalCloseGuardOptions
): boolean {
  if (options?.force === true || options?.rejectPinned === true) {
    return false
  }
  if (options?.skipRunningProcessConfirm === true || options?.lifecyclePtyId !== undefined) {
    return false
  }
  const isUserReason = (reason: TerminalTabCloseReason | undefined): boolean =>
    reason === undefined || reason === 'user'
  return isUserReason(options?.reason) && isUserReason(options?.hostCloseReason)
}

/** Every PTY the tab could still own, plus the subset `ptyIdsByTabId` vouches for.
 *  `ptyIdsByTabId` is the liveness map the rest of the app reads — the window-close guard
 *  reads only it — but a mounting pane is bound into the layout before the map catches up,
 *  and the store's own teardown collector unions both for exactly that reason: reading only
 *  the map would let a close slip through the window with no prompt. The union is safe only
 *  for a *positive* answer, so the tracked set travels with it. */
function collectTabPtyIds(
  state: Pick<AppState, 'ptyIdsByTabId' | 'terminalLayoutsByTabId'>,
  terminalTabId: string
): { ptyIds: string[]; trackedPtyIds: ReadonlySet<string> } {
  const trackedPtyIds = new Set<string>()
  for (const ptyId of state.ptyIdsByTabId?.[terminalTabId] ?? []) {
    if (ptyId) {
      trackedPtyIds.add(ptyId)
    }
  }
  const ptyIds = new Set<string>(trackedPtyIds)
  const ptyIdsByLeafId = state.terminalLayoutsByTabId?.[terminalTabId]?.ptyIdsByLeafId ?? {}
  for (const ptyId of Object.values(ptyIdsByLeafId)) {
    if (typeof ptyId === 'string' && ptyId) {
      ptyIds.add(ptyId)
    }
  }
  return { ptyIds: [...ptyIds], trackedPtyIds }
}

/**
 * Routes an interactive terminal-tab close through the running-process confirmation.
 * Closes immediately when nothing is running, so idle tabs keep today's behavior.
 */
export function guardRunningTerminalClose(params: {
  terminalTabId: string
  tabLabel: string
  onClose: () => void
  onCancel?: () => void
}): void {
  const { terminalTabId, tabLabel, onClose, onCancel } = params
  const state = useAppStore.getState()
  const settings = state.settings
  const { ptyIds, trackedPtyIds } = collectTabPtyIds(state, terminalTabId)
  // Why: no PTY at all means there is nothing to probe (parked/hibernated tab, or a
  // teardown that already cleared both maps), and the opt-out setting means the answer is
  // already known. Both keep the close fully synchronous.
  if (ptyIds.length === 0 || settings?.skipCloseTerminalWithRunningProcessConfirm === true) {
    onClose()
    return
  }

  // Why: the timeout, the probe result and the error path race to decide this close, so the
  // first one to land owns it instead of trusting those races to stay mutually exclusive.
  let decided = false
  const closeNow = (): void => {
    if (decided) {
      return
    }
    decided = true
    onClose()
  }
  const confirmClose = (busyPtyIds: readonly string[]): void => {
    if (decided) {
      return
    }
    const copyKind = resolveBusyPtyCloseCopyKind(terminalTabId, busyPtyIds)
    useRunningTerminalCloseConfirmStore.getState().requestRunningTerminalCloseConfirm({
      terminalTabId,
      tabLabel,
      copyKind,
      onConfirm: onClose,
      ...(onCancel ? { onCancel } : {})
    })
    // Why: only once the prompt is actually up — if either call above throws, the close must
    // still be free to fall through and happen.
    decided = true
  }

  const probeTimeout = setTimeout(() => {
    try {
      // Why: a probe that has not answered yet is unknown, not idle. Ask, treating every pty
      // as a candidate, so a degraded relay costs a click instead of a killed remote command.
      confirmClose(ptyIds)
    } catch {
      closeNow()
    }
  }, RUNNING_CLOSE_PROBE_TIMEOUT_MS)

  void Promise.allSettled(ptyIds.map((ptyId) => inspectRuntimeTerminalProcess(settings, ptyId)))
    .then((results) => {
      clearTimeout(probeTimeout)
      if (decided) {
        return
      }
      // Why: fail open on a *rejection* (wedged relay, legacy provider), matching the Cmd+W
      // pane path — a close button that silently does nothing is worse than closing a busy
      // tab. `unavailable` now means exactly "could not ask", which this guard's own timeout
      // already prompts on, so an answered non-answer asks too — but only for an id the
      // liveness map still vouches for, the same id set the window-close guard reads. A
      // layout-only id is usually a leftover leaf whose pane is long gone: it answers
      // `unavailable` forever, and prompting on it would put a dialog in front of every
      // cleanly-exited tab. It can still block the close by answering *positively*, which is
      // the mounting-pane window the union exists for.
      const busyPtyIds = ptyIds.filter((ptyId, index) => {
        const result = results[index]
        if (result?.status !== 'fulfilled') {
          return false
        }
        if (result.value.hasChildProcesses) {
          return true
        }
        return result.value.unavailable === true && trackedPtyIds.has(ptyId)
      })
      if (busyPtyIds.length === 0) {
        closeNow()
        return
      }
      confirmClose(busyPtyIds)
    })
    // Why: allSettled never rejects, so this only fires when the decision above throws (a
    // copy-kind lookup, a store subscriber). Without it the tab would silently never close
    // and the user would get no feedback at all; the pane path it replaced had this catch.
    .catch(() => {
      clearTimeout(probeTimeout)
      closeNow()
    })
}
