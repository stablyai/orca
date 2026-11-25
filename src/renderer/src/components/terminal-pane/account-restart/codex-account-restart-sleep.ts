import { useAppStore } from '@/store/index'
import { collectSleepingAgentSessionRecordsForWorktree } from '@/store/slices/agent-status/sleep-recovery/agent-status-recovery-collection'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'

type SleepPane = {
  worktreeId: string
  tabId: string
  leafId: string
  ptyId: string
}

/**
 * The restart is a sleep, then the pane's normal wake: the exit retires the pane's live agent row
 * before the wake reads it, so the pane's resume record is written first, as hibernation does.
 * Returns the undo for a stop that never ended the process, or null when nothing was recorded.
 */
export function sleepPaneForAccountRestart(
  pane: SleepPane
): ((outcomeStopped: boolean) => void) | null {
  let paneKey: string
  try {
    paneKey = makePaneKey(pane.tabId, pane.leafId)
  } catch {
    return null
  }
  const state = useAppStore.getState()
  const record = captureRecord(state, pane.worktreeId, paneKey)
  if (!record) {
    // No verified thread: main refuses the stop (no-session), so there is nothing to wake.
    return null
  }
  const previous = state.sleepingAgentSessionsByPaneKey[paneKey]
  state.rememberSleepingAgentSession(record, previous)
  return (outcomeStopped) => {
    const current = useAppStore.getState()
    const stillRunning = (current.ptyIdsByTabId[pane.tabId] ?? []).includes(pane.ptyId)
    // A stop that ended the process is woken from this record; one that did not leaves it running.
    if (outcomeStopped || !stillRunning) {
      return
    }
    if (current.sleepingAgentSessionsByPaneKey[paneKey] !== record) {
      return
    }
    if (previous) {
      current.rememberSleepingAgentSession(previous, record)
    } else {
      current.clearSleepingAgentSession(paneKey)
    }
  }
}

function captureRecord(
  state: ReturnType<typeof useAppStore.getState>,
  worktreeId: string,
  paneKey: string
): SleepingAgentSessionRecord | undefined {
  // A finished turn sleeps as completed-agent hibernation does; a running one as a manual sleep.
  return (
    collectSleepingAgentSessionRecordsForWorktree(state, worktreeId, {
      paneKeys: [paneKey],
      captureMode: 'completed-agent-hibernation'
    })[paneKey] ??
    collectSleepingAgentSessionRecordsForWorktree(state, worktreeId, {
      paneKeys: [paneKey],
      captureMode: 'manual-worktree-sleep'
    })[paneKey]
  )
}
