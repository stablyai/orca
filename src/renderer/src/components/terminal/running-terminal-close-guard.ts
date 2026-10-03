import { useAppStore } from '@/store'
import {
  useRunningTerminalCloseConfirmStore,
  type RunningTerminalCloseSubject
} from '@/store/running-terminal-close-confirm'
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

/** Every PTY the tab could still own. `ptyIdsByTabId` is the liveness map the rest of the
 *  app reads, but a mounting pane is bound into the layout before the map catches up, and
 *  the store's own teardown collector unions both for exactly that reason — reading only
 *  the map would let a close slip through the window with no prompt. A stale id costs
 *  nothing: its probe fails and the guard falls open. */
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

function guardRunningTerminalPtyClose({
  settings,
  ptyIds,
  onClose,
  requestConfirm
}: {
  settings: AppState['settings']
  ptyIds: string[]
  onClose: () => void
  requestConfirm: (busyPtyIds: string[], timedOut: boolean) => void
}): void {
  if (ptyIds.length === 0 || settings?.skipCloseTerminalWithRunningProcessConfirm === true) {
    onClose()
    return
  }

  // Why: only the first probe decision may close or raise a prompt.
  let decided = false
  const closeNow = (): void => {
    if (decided) {
      return
    }
    decided = true
    onClose()
  }

  void probePtyRunningWork(settings, ptyIds, { timeoutMs: RUNNING_CLOSE_PROBE_TIMEOUT_MS })
    .then((probes) => {
      if (decided) {
        return
      }
      // Why: a deadline is unknown, not evidence that the execution host has no running work.
      const busyPtyIds = probes
        .filter((probe) => probe.timedOut || probe.verdict === 'live')
        .map((probe) => probe.ptyId)
      if (busyPtyIds.length === 0) {
        closeNow()
        return
      }
      requestConfirm(
        busyPtyIds,
        probes.some((probe) => probe.timedOut)
      )
      // Why: a failed lookup or store subscriber must still fall through to the close.
      decided = true
    })
    .catch(closeNow)
}

/** Routes an interactive tab close through the running-process confirmation. */
export function guardRunningTerminalClose(params: {
  terminalTabId: string
  tabLabel: string
  onClose: () => void
  onCancel?: () => void
}): void {
  const { terminalTabId, tabLabel, onClose, onCancel } = params
  const state = useAppStore.getState()
  const ptyIds = collectTabPtyIds(state, terminalTabId)
  guardRunningTerminalPtyClose({
    settings: state.settings,
    ptyIds,
    onClose,
    requestConfirm: (busyPtyIds, timedOut) => {
      useRunningTerminalCloseConfirmStore.getState().requestRunningTerminalCloseConfirm({
        terminalTabId,
        tabLabel,
        copyKind: resolveBusyPtyCloseCopyKind(terminalTabId, timedOut ? ptyIds : busyPtyIds),
        onConfirm: onClose,
        ...(onCancel ? { onCancel } : {})
      })
    }
  })
}

/** Keeps every group member open until its one running-process prompt is accepted. */
export function guardRunningTerminalGroupClose(params: {
  subjectKey: string
  groupLabel: string
  terminals: { terminalTabId: string; tabLabel: string }[]
  onClose: () => void
  onCancel?: () => void
}): void {
  const { subjectKey, groupLabel, terminals, onClose, onCancel } = params
  const state = useAppStore.getState()
  const terminalPtys = terminals.map((terminal) => ({
    ...terminal,
    ptyIds: collectTabPtyIds(state, terminal.terminalTabId)
  }))
  guardRunningTerminalPtyClose({
    settings: state.settings,
    ptyIds: [...new Set(terminalPtys.flatMap((terminal) => terminal.ptyIds))],
    onClose,
    requestConfirm: (busyPtyIds) => {
      const busyPtySet = new Set(busyPtyIds)
      const groupTerminals: RunningTerminalCloseSubject[] = []
      for (const terminal of terminalPtys) {
        const terminalBusyPtyIds = terminal.ptyIds.filter((ptyId) => busyPtySet.has(ptyId))
        if (terminalBusyPtyIds.length === 0) {
          continue
        }
        groupTerminals.push({
          terminalTabId: terminal.terminalTabId,
          tabLabel: terminal.tabLabel,
          copyKind: resolveBusyPtyCloseCopyKind(terminal.terminalTabId, terminalBusyPtyIds)
        })
      }
      useRunningTerminalCloseConfirmStore.getState().requestRunningTerminalCloseConfirm({
        terminalTabId: subjectKey,
        tabLabel: groupLabel,
        copyKind: groupTerminals.some((terminal) => terminal.copyKind === 'agent')
          ? 'agent'
          : 'command',
        groupTerminals,
        onConfirm: onClose,
        ...(onCancel ? { onCancel } : {})
      })
    }
  })
}
