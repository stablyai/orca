import { useAppStore } from '@/store'
import { useRunningTerminalCloseConfirmStore } from '@/store/slices/tabs/closing/running-terminal-close-confirm'
import type { TerminalTabCloseReason } from '@/store/terminals/retirement/terminal-tab-retirement'
import type { TerminalTabCloseIntent } from './terminal-tab-close-intent'
import type { AppState } from '@/store/types'
import { resolveBusyPtyCloseCopyKind } from './terminal-close-copy-kind'
import { canSleepInsteadOfClosingTab } from './terminal-close-sleep-eligibility'
import { probePtyRunningWork } from './pty-running-work-probe'

export type RunningTerminalCloseGuardOptions = {
  force?: boolean
  rejectPinned?: boolean
  reason?: TerminalTabCloseIntent
  hostCloseReason?: TerminalTabCloseReason
  lifecyclePtyId?: string
  skipRunningProcessConfirm?: boolean
}

/** Bound remote probe waits, then prompt: silence is unknown and must not authorize killing work (#10142). */
export const RUNNING_CLOSE_PROBE_TIMEOUT_MS = 4_000

/** Only interactive closes ask; lifecycle, bulk, CLI/RPC and confirmed re-entry skip this guard. */
export function shouldConfirmRunningTerminalClose(
  options?: RunningTerminalCloseGuardOptions
): boolean {
  if (options?.force === true || options?.rejectPinned === true) {
    return false
  }
  if (options?.skipRunningProcessConfirm === true || options?.lifecyclePtyId !== undefined) {
    return false
  }
  const isUserReason = (reason: TerminalTabCloseIntent | undefined): boolean =>
    reason === undefined || reason === 'user'
  return isUserReason(options?.reason) && isUserReason(options?.hostCloseReason)
}

/** Union liveness and layout PTYs because layout binds first during mount; stale handles fail open. */
export function collectTabPtyIds(
  state: Pick<AppState, 'ptyIdsByTabId' | 'terminalLayoutsByTabId'>,
  terminalTabId: string
): string[] {
  const ptyIds = new Set<string>()
  for (const ptyId of state.ptyIdsByTabId?.[terminalTabId] ?? []) {
    if (ptyId) {
      ptyIds.add(ptyId)
    }
  }
  const ptyIdsByLeafId = state.terminalLayoutsByTabId?.[terminalTabId]?.ptyIdsByLeafId ?? {}
  for (const ptyId of Object.values(ptyIdsByLeafId)) {
    if (typeof ptyId === 'string' && ptyId) {
      ptyIds.add(ptyId)
    }
  }
  return [...ptyIds]
}

export function guardRunningTerminalClose(params: {
  terminalTabId: string
  /** The workspace owning the tab; names it in the prompt and gates "Sleep workspace instead". */
  worktreeId?: string
  /** Work the user already agreed to stop is not running work to ask about. */
  consentedPtyId?: string
  /** A group/pane close is deliberate; it does not ask for each idle tab inside it. */
  skipIdleCloseConfirm?: boolean
  /** This call is an idle recheck; its probe may open a prompt after the idle callback returned. */
  guardNextPromptFromRecheck?: boolean
  onClose: () => void
  /** Confirm on the idle prompt; re-check running work so a tab that became busy during the prompt still asks. */
  onIdleConfirm?: () => void
  onCancel?: () => void
}): void {
  const {
    terminalTabId,
    worktreeId,
    consentedPtyId,
    skipIdleCloseConfirm,
    guardNextPromptFromRecheck,
    onClose,
    onIdleConfirm,
    onCancel
  } = params
  const state = useAppStore.getState()
  const settings = state.settings
  const ptyIds = collectTabPtyIds(state, terminalTabId).filter((id) => id !== consentedPtyId)
  // The idle prompt is its own opt-in, so "don't ask again" for running work must not hide it.
  // A consented close is already deliberate; it must not look idle after its pty is filtered out.
  const confirmIdle =
    settings?.confirmCloseIdleTabs === true &&
    skipIdleCloseConfirm !== true &&
    consentedPtyId === undefined
  const skipRunning = settings?.skipCloseTerminalWithRunningProcessConfirm === true

  // Probe, timeout, and errors race; only the first decision may own the close.
  let decided = false
  const closeNow = (): void => {
    if (decided) {
      return
    }
    decided = true
    onClose()
  }
  const requestIdleConfirm = (): void => {
    if (decided) {
      return
    }
    useRunningTerminalCloseConfirmStore.getState().requestRunningTerminalCloseConfirm({
      terminalTabId,
      copyKind: 'idle',
      ...(worktreeId ? { worktreeId } : {}),
      ...(guardNextPromptFromRecheck ? { guardWhenVisible: true } : {}),
      onConfirm: onIdleConfirm ?? onClose,
      ...(onCancel ? { onCancel } : {})
    })
    decided = true
  }
  const confirmClose = (busyPtyIds: readonly string[]): void => {
    if (decided) {
      return
    }
    const copyKind = resolveBusyPtyCloseCopyKind(terminalTabId, busyPtyIds)
    const canSleepInstead =
      copyKind === 'agent' && worktreeId !== undefined
        ? canSleepInsteadOfClosingTab(useAppStore.getState(), {
            worktreeId,
            terminalTabId,
            busyPtyIds
          })
        : false
    useRunningTerminalCloseConfirmStore.getState().requestRunningTerminalCloseConfirm({
      terminalTabId,
      copyKind,
      ...(worktreeId ? { worktreeId } : {}),
      ...(canSleepInstead ? { canSleepInstead } : {}),
      ...(guardNextPromptFromRecheck ? { guardWhenVisible: true } : {}),
      onConfirm: onClose,
      ...(onCancel ? { onCancel } : {})
    })
    // Claim ownership only once the prompt opens so thrown lookups can still fall through.
    decided = true
  }

  if (ptyIds.length === 0) {
    if (confirmIdle) {
      requestIdleConfirm()
      return
    }
    closeNow()
    return
  }
  if (skipRunning && !confirmIdle) {
    closeNow()
    return
  }

  void probePtyRunningWork(ptyIds, { timeoutMs: RUNNING_CLOSE_PROBE_TIMEOUT_MS })
    .then((probes) => {
      if (decided) {
        return
      }
      // Unanswered probes are unknown; prompt for every candidate rather than kill uninspected remote work.
      if (probes.some((probe) => probe.timedOut)) {
        if (skipRunning) {
          closeNow()
          return
        }
        confirmClose(ptyIds)
        return
      }
      // "Could not tell" must not kill a bound pty's work (#33265); layout-only ids are often stale leaves that never answer.
      const boundPtyIds = new Set(useAppStore.getState().ptyIdsByTabId?.[terminalTabId] ?? [])
      const busyPtyIds = probes
        .filter(
          (probe) =>
            probe.verdict === 'live' ||
            (probe.verdict === 'unverifiable' && boundPtyIds.has(probe.ptyId))
        )
        .map((probe) => probe.ptyId)
      if (busyPtyIds.length === 0) {
        if (confirmIdle) {
          requestIdleConfirm()
          return
        }
        closeNow()
        return
      }
      if (skipRunning) {
        closeNow()
        return
      }
      confirmClose(busyPtyIds)
    })
    // Probe never rejects, but decision callbacks can throw; retain the pane path’s feedback/fallback instead of silently blocking close.
    .catch(() => {
      closeNow()
    })
}
