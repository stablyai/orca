import { isAiVaultAgent } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import type { AppState } from '@/store/types'
import { readTabMapChanges } from '@/store/record-transitions/keyed-record-change-reads'
import {
  ownerInputsChanged,
  relevantRecordEqual
} from '../title-sync/ai-vault-tab-title-sync-inputs'
import { reconcileTerminalSessionNames } from './terminal-session-name-pass'
import { terminalTabNameUnsettled } from './terminal-session-name-recording'

type SyncDependencies = {
  getState: () => AppState
  subscribe: (listener: (state: AppState, previous: AppState) => void) => () => void
  scheduleReconcile: (callback: () => void) => () => void
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
  now?: () => number
}

/** Tab ids or names changed. Title churn replaces one bucket, so only changed buckets are read. */
export function terminalTabNamesChanged(current: AppState, previous: AppState): boolean {
  if (current.tabsByWorktree === previous.tabsByWorktree) {
    return false
  }
  const changes = readTabMapChanges(current.tabsByWorktree, previous.tabsByWorktree)
  if (changes?.kind === 'addressed' && changes.workspaceSetChanged) {
    return true
  }
  let worktreeIds: Iterable<string>
  if (changes?.kind === 'addressed') {
    worktreeIds = changes.workspaceIds
  } else {
    const currentKeys = Object.keys(current.tabsByWorktree)
    if (currentKeys.length !== Object.keys(previous.tabsByWorktree).length) {
      return true
    }
    worktreeIds = currentKeys
  }
  for (const worktreeId of worktreeIds) {
    const tabs = current.tabsByWorktree[worktreeId]
    const before = previous.tabsByWorktree[worktreeId]
    if (tabs === before) {
      continue
    }
    if (!before || tabs.length !== before.length) {
      return true
    }
    for (let index = 0; index < tabs.length; index++) {
      if (
        tabs[index].id !== before[index].id ||
        (tabs[index].customTitle ?? null) !== (before[index].customTitle ?? null)
      ) {
        return true
      }
    }
  }
  return false
}

/** Tabs in `previous` gone from `current` whose session name the last pass has not settled. */
export function unsettledTerminalTabsClosed(current: AppState, previous: AppState): Set<string> {
  const open = new Set<string>()
  for (const tabs of Object.values(current.tabsByWorktree)) {
    for (const tab of tabs) {
      open.add(tab.id)
    }
  }
  const unsettled = new Set<string>()
  for (const [worktreeId, tabs] of Object.entries(previous.tabsByWorktree)) {
    for (const tab of tabs) {
      if (!open.has(tab.id) && terminalTabNameUnsettled(previous, worktreeId, tab)) {
        unsettled.add(tab.id)
      }
    }
  }
  return unsettled
}

const sessionIdOf = (entry: { providerSession?: { id?: string } }) => entry.providerSession?.id

/** Which session runs in which pane changed, for any agent; status heartbeats leave this false. */
export function agentSessionBindingsChanged(current: AppState, previous: AppState): boolean {
  const statuses = current.agentStatusByPaneKey
  const priorStatuses = previous.agentStatusByPaneKey
  if (
    statuses !== priorStatuses &&
    (!statuses.sharesOwner(priorStatuses) ||
      statuses.sessionRevision !== priorStatuses.sessionRevision)
  ) {
    return true
  }
  const sleepingEqual = relevantRecordEqual(
    current.sleepingAgentSessionsByPaneKey,
    previous.sleepingAgentSessionsByPaneKey,
    (entry) => isAiVaultAgent(entry.agent) && Boolean(sessionIdOf(entry)),
    (left, right) =>
      left.agent === right.agent &&
      left.paneKey === right.paneKey &&
      left.tabId === right.tabId &&
      left.worktreeId === right.worktreeId &&
      sessionIdOf(left) === sessionIdOf(right)
  )
  if (!sleepingEqual) {
    return true
  }
  return !relevantRecordEqual(
    current.agentConversationsByPaneKey ?? {},
    previous.agentConversationsByPaneKey ?? {},
    (entry) => isAiVaultAgent(entry.agent) && Boolean(sessionIdOf(entry)),
    (left, right) =>
      left.agent === right.agent &&
      left.paneKey === right.paneKey &&
      left.worktreeId === right.worktreeId &&
      left.executionHostId === right.executionHostId &&
      sessionIdOf(left) === sessionIdOf(right)
  )
}

/** Keeps saved terminal session names in step with tab names; see terminal-session-name-recording. */
export function startTerminalSessionNameSync(dependencies: SyncDependencies): () => void {
  const setTimer = dependencies.setTimer ?? setTimeout
  const clearTimer = dependencies.clearTimer ?? clearTimeout
  const now = dependencies.now ?? Date.now
  let stopped = false
  let cancelScheduled: (() => void) | null = null
  let recheckTimer: ReturnType<typeof setTimeout> | null = null
  // A pass skipped a tab whose host was not known yet; watch owner facts until one does not.
  let hostSkipped = false

  function reconcile(): void {
    cancelScheduled = null
    if (stopped) {
      return
    }
    const result = reconcileTerminalSessionNames(dependencies.getState(), now())
    hostSkipped = result.hostSkipped
    if (recheckTimer !== null) {
      clearTimer(recheckTimer)
      recheckTimer = null
    }
    if (result.recheckAt !== null) {
      recheckTimer = setTimer(
        () => {
          recheckTimer = null
          schedule()
        },
        Math.max(0, result.recheckAt - now())
      )
    }
  }

  function schedule(): void {
    if (cancelScheduled || stopped) {
      return
    }
    cancelScheduled = dependencies.scheduleReconcile(reconcile)
  }

  const unsubscribe = dependencies.subscribe((state, previous) => {
    const tabNamesChanged = terminalTabNamesChanged(state, previous)
    const closing =
      tabNamesChanged && cancelScheduled ? unsettledTerminalTabsClosed(state, previous) : null
    if (closing && closing.size > 0) {
      // A waiting pass never sees tabs that close before it runs, so a name that just arrived
      // from another client would be lost; settle those tabs from the state they closed in, and
      // leave every other tab for the waiting pass.
      try {
        reconcileTerminalSessionNames(previous, now(), { onlyTabIds: closing })
      } catch (error) {
        // This runs inside the store update that closed the tab; it must never break the close.
        console.warn('[terminal-session-names] could not settle names on tab close:', error)
      }
    }
    if (
      tabNamesChanged ||
      agentSessionBindingsChanged(state, previous) ||
      (hostSkipped && ownerInputsChanged(state, previous))
    ) {
      schedule()
    }
  })
  // Tabs restored with names, and names saved by an older run, need one look at mount.
  schedule()

  return () => {
    stopped = true
    unsubscribe()
    cancelScheduled?.()
    cancelScheduled = null
    if (recheckTimer !== null) {
      clearTimer(recheckTimer)
    }
  }
}
