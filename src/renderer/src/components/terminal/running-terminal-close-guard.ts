import { useAppStore } from '@/store'
import {
  inspectRuntimeTerminalProcess,
  type RuntimeTerminalProcessInspection
} from '@/runtime/runtime-terminal-inspection'
import { useRunningTerminalCloseConfirmStore } from '@/store/running-terminal-close-confirm'
import type { TerminalTabCloseReason } from '@/store/slices/terminal-tab-retirement'
import type { AppState } from '@/store/types'
import { readPtyProcessInspectionEvidenceForAbsenceAction } from '../../../../shared/pty-process-inspection-evidence'
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

type SettledCloseProbe =
  | { status: 'fulfilled'; value: RuntimeTerminalProcessInspection }
  | { status: 'rejected' }

function shouldConfirmForProbe(
  ptyId: string,
  trackedPtyIds: ReadonlySet<string>,
  probe: SettledCloseProbe | undefined
): boolean {
  const tracked = trackedPtyIds.has(ptyId)
  if (probe === undefined || probe.status === 'rejected') {
    return tracked
  }
  if (probe.value.unavailable === true) {
    return tracked
  }
  // Why the absence-action reader and not the plain one: closing here kills the pty, and the
  // plain reader manufactures `exited` out of a host that published no verdict at all — a
  // retained pre-v27 daemon, a provider with no `inspectProcess`, or any relay/runtime host
  // older than the field. That shape carries neither `unavailable` nor `processEvidence`, so
  // it slipped past both arms above and closed silently over work the window-close guard was
  // already asking about.
  const children = readPtyProcessInspectionEvidenceForAbsenceAction(probe.value).children
  // Why the verdict alone decides, with no vote from `hasChildProcesses`: the boolean is
  // `children.verdict === 'live'` collapsed, so it says nothing new on the positive pole and
  // nothing trustworthy on the others. The one producer that publishes `true` beside a
  // non-`live` verdict is a daemon pane whose handle has no evidence channel, and that host
  // states outright that such a read proves neither life nor exit — so voting on it would ask
  // for a non-shell title and close silently for a shell one, off the very same degraded read.
  // The window-close guard reads this same single signal, off the same reader (#17077).
  if (children.verdict === 'live') {
    return true
  }
  return children.verdict === 'unverifiable' && tracked
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

  const settledProbes = new Map<string, SettledCloseProbe>()
  const probeTimeout = setTimeout(() => {
    try {
      const busyPtyIds = ptyIds.filter((ptyId) =>
        shouldConfirmForProbe(ptyId, trackedPtyIds, settledProbes.get(ptyId))
      )
      if (busyPtyIds.length === 0) {
        closeNow()
        return
      }
      confirmClose(busyPtyIds)
    } catch {
      closeNow()
    }
  }, RUNNING_CLOSE_PROBE_TIMEOUT_MS)

  const probes = ptyIds.map(async (ptyId): Promise<SettledCloseProbe> => {
    let probe: SettledCloseProbe
    try {
      probe = { status: 'fulfilled', value: await inspectRuntimeTerminalProcess(settings, ptyId) }
    } catch {
      probe = { status: 'rejected' }
    }
    settledProbes.set(ptyId, probe)
    return probe
  })

  void Promise.all(probes)
    .then((results) => {
      clearTimeout(probeTimeout)
      if (decided) {
        return
      }
      // Why: a non-answer asks — a rejection (wedged relay, legacy provider), `unavailable`
      // ("could not ask") and an `unverifiable` children verdict ("reached it, could not tell")
      // are the same evidence as this guard's own timeout, and this close kills the pty, so it
      // owes the same prompt the window-close path already gives. All three narrow to an id the
      // liveness map still vouches for, the id set the window-close guard reads. A layout-only
      // id is usually a leftover leaf whose pane is long gone — it answers a non-answer forever,
      // and prompting on it would put a dialog in front of every cleanly-exited tab and every
      // reconnecting ssh tab. It can still block by answering *positively*, the mounting-pane
      // window the union exists for.
      const busyPtyIds = ptyIds.filter((ptyId, index) =>
        shouldConfirmForProbe(ptyId, trackedPtyIds, results[index])
      )
      if (busyPtyIds.length === 0) {
        closeNow()
        return
      }
      confirmClose(busyPtyIds)
    })
    // Why: each probe catches its own rejection, so this only fires when the decision above throws (a
    // copy-kind lookup, a store subscriber). Without it the tab would silently never close
    // and the user would get no feedback at all; the pane path it replaced had this catch.
    .catch(() => {
      clearTimeout(probeTimeout)
      closeNow()
    })
}
