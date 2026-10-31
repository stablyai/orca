import { useAppStore } from '@/store'
import { useRunningTerminalCloseConfirmStore } from '@/store/running-terminal-close-confirm'
import type { TerminalTabCloseReason } from '@/store/slices/terminal-tab-retirement'
import type { AppState } from '@/store/types'
import { resolveBusyPtyCloseCopyKind } from './terminal-close-copy-kind'
import { probePtyRunningWork } from './pty-running-work-probe'

export type RunningTerminalCloseGuardOptions = {
  force?: boolean
  rejectPinned?: boolean
  reason?: TerminalTabCloseReason
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
  const isUserReason = (reason: TerminalTabCloseReason | undefined): boolean =>
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
  tabLabel: string
  onClose: () => void
  onCancel?: () => void
}): void {
  const { terminalTabId, tabLabel, onClose, onCancel } = params
  const state = useAppStore.getState()
  const settings = state.settings
  const ptyIds = collectTabPtyIds(state, terminalTabId)
  // Opt-out and no-PTY closes stay synchronous.
  if (ptyIds.length === 0 || settings?.skipCloseTerminalWithRunningProcessConfirm === true) {
    onClose()
    return
  }

  // Probe, timeout, and errors race; only the first decision may own the close.
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
    // Claim ownership only once the prompt opens so thrown lookups can still fall through.
    decided = true
  }

  void probePtyRunningWork(ptyIds, { timeoutMs: RUNNING_CLOSE_PROBE_TIMEOUT_MS })
    .then((probes) => {
      if (decided) {
        return
      }
      // Unanswered probes are unknown; prompt for every candidate rather than kill uninspected remote work.
      if (probes.some((probe) => probe.timedOut)) {
        confirmClose(ptyIds)
        return
      }
      // Answered probe failures/stale handles fail open like Cmd+W; they provide no live-child evidence and must not disable closing.
      const busyPtyIds = probes
        .filter((probe) => probe.verdict === 'live')
        .map((probe) => probe.ptyId)
      if (busyPtyIds.length === 0) {
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
