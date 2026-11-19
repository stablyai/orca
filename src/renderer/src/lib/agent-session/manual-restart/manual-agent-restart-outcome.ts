/** Counts manual agent restarts by whether each pane's leaf really moved to a new PTY, so the summary never reports a request as a restart. */
import { useAppStore } from '@/store/index'
import { isTerminalTabPresent } from '@/store/terminals/retirement/terminal-tab-retirement'
import { isDetachedRestartInFlight } from '@/components/terminal-pane/account-restart/detached/codex-detached-pane-restart'
import { STALLED_DETACHED_RESTART_MS } from '@/components/terminal-pane/account-restart/detached/detached-pane-restart-slots'
import { collectLeafIds } from '../../../../../shared/workspace-layout/terminal-topology/terminal-pane-layout-tree'
import type { AppState } from '@/store/types'

export type ManualRestartOutcome = { restarted: number; failed: number }

type TrackedPane = { tabId: string; leafId: string; ptyId: string; consumedPtyId: string | null }

function boundPtyId(state: AppState, pane: TrackedPane): string | undefined {
  return state.terminalLayoutsByTabId[pane.tabId]?.ptyIdsByLeafId?.[pane.leafId] || undefined
}

function followReattachRotation(state: AppState, pane: TrackedPane): void {
  const bound = boundPtyId(state, pane)
  if (
    pane.consumedPtyId === null &&
    bound &&
    bound !== pane.ptyId &&
    bound in state.pendingPaneManualRestarts
  ) {
    pane.ptyId = bound
  }
}

function judgePane(state: AppState, pane: TrackedPane): keyof ManualRestartOutcome | null {
  const bound = boundPtyId(state, pane)
  // Why a binding counts: headless layouts can bind a leaf their root does not name.
  const leafPresent =
    bound !== undefined ||
    collectLeafIds(state.terminalLayoutsByTabId[pane.tabId]?.root).includes(pane.leafId)
  if (!isTerminalTabPresent(state, pane.tabId) || !leafPresent) {
    return 'failed'
  }
  if (pane.consumedPtyId === null) {
    if (pane.ptyId in state.pendingPaneManualRestarts) {
      return null
    }
    pane.consumedPtyId = pane.ptyId
  }
  if (bound !== undefined && bound !== pane.consumedPtyId) {
    return 'restarted'
  }
  // An empty binding is a mounted restart between stopping the old PTY and binding the new one.
  if (bound === pane.consumedPtyId && !isDetachedRestartInFlight(bound)) {
    return 'failed'
  }
  return null
}

export function trackManualAgentRestarts(
  panes: { tabId: string; leafId: string; ptyId: string }[]
): Promise<ManualRestartOutcome> {
  const outcome: ManualRestartOutcome = { restarted: 0, failed: 0 }
  let pending: TrackedPane[] = panes.map((pane) => ({ ...pane, consumedPtyId: null }))
  if (pending.length === 0) {
    return Promise.resolve(outcome)
  }
  return new Promise((resolve) => {
    let judgeQueued = false
    const finish = (): void => {
      unsubscribe()
      clearTimeout(deadline)
      resolve(outcome)
    }
    const judgeAll = (): void => {
      judgeQueued = false
      const state = useAppStore.getState()
      pending = pending.filter((pane) => {
        const verdict = judgePane(state, pane)
        if (verdict) {
          outcome[verdict] += 1
        }
        return verdict === null
      })
      if (pending.length === 0) {
        finish()
      }
    }
    // Why a microtask: the detached sweep marks a pane in flight only after its consume write.
    const queueJudge = (): void => {
      if (!judgeQueued) {
        judgeQueued = true
        queueMicrotask(judgeAll)
      }
    }
    const unsubscribe = useAppStore.subscribe((state) => {
      // Why now, not in the microtask: the detached sweep can consume a moved entry before it runs.
      for (const pane of pending) {
        followReattachRotation(state, pane)
      }
      queueJudge()
    })
    const deadline = setTimeout(() => {
      const late = pending
      pending = []
      outcome.failed += late.length
      finish()
      // Why drop: a restart that runs after the summary said it failed would surprise the user.
      for (const pane of late) {
        useAppStore.getState().dropPendingPaneManualRestart(pane.ptyId)
      }
    }, STALLED_DETACHED_RESTART_MS)
    queueJudge()
  })
}
