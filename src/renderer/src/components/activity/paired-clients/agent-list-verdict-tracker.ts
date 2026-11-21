import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { AgentListVerdict } from '../../../../../shared/agent-status/presentation/agent-list-status'
import { isRunningActivityState } from '../events/activity-event-state'
import { isClearableActivityThread } from '../thread-list/activity-clear-completed'
import {
  childAgentLineageInputs,
  classifyChildAgents
} from '../threads/activity-thread-child-agent'
import { activityThreadStatusId } from '../threads/activity-thread-presentation'
import type { AgentPaneThread } from '../threads/activity-thread-types'

type ListedVerdict = Extract<AgentListVerdict, { listed: true }>

export type AgentListVerdictSources = {
  threads: readonly AgentPaneThread[]
  thread: (paneKey: string) => AgentPaneThread | undefined
  statuses: ReadonlyMap<string, AgentStatusEntry>
  acknowledgedAt: Readonly<Record<string, number>>
}

export type AgentListVerdictChanges = {
  changed: Record<string, AgentListVerdict>
  removed: string[]
}

type Lineage = { terminalHandle: string | undefined; orchestration: string | null }

// Threads keep their identity across unrelated writes, so only a changed thread rebuilds its verdict.
const threadVerdicts = new WeakMap<AgentPaneThread, ListedVerdict>()

function threadVerdict(thread: AgentPaneThread): ListedVerdict {
  let verdict = threadVerdicts.get(thread)
  if (!verdict) {
    verdict = {
      listed: true,
      status: activityThreadStatusId(thread),
      unread: thread.unread,
      clearable: isClearableActivityThread(thread),
      sortAt: thread.latestTimestamp,
      title: thread.paneTitle
    }
    threadVerdicts.set(thread, verdict)
  }
  return verdict
}

function sameVerdict(a: AgentListVerdict, b: AgentListVerdict): boolean {
  if (a === b) {
    return true
  }
  if (!a.listed || !b.listed) {
    return a.listed === b.listed && a.unread === b.unread
  }
  return (
    a.status === b.status &&
    a.unread === b.unread &&
    a.clearable === b.clearable &&
    a.sortAt === b.sortAt &&
    a.title === b.title &&
    a.childOf === b.childOf &&
    a.foldedChild === b.foldedChild
  )
}

/**
 * The Agents list's verdict for every pane the window knows, kept current from the panes callers
 * mark changed: each collect costs O(marked), except a child-agent lineage change, which
 * reclassifies every thread once.
 */
export function createAgentListVerdictTracker() {
  const verdicts = new Map<string, AgentListVerdict>()
  const lineageByPaneKey = new Map<string, Lineage>()
  const handleCounts = new Map<string, number>()
  let duplicateHandles = 0
  let orchestratedThreads = 0
  let parentByChild = new Map<string, string>()
  let pending = new Set<string>()
  let full = true

  function countHandle(handle: string | undefined, delta: 1 | -1): void {
    if (!handle) {
      return
    }
    const before = handleCounts.get(handle) ?? 0
    const after = before + delta
    duplicateHandles += Number(after > 1) - Number(before > 1)
    if (after === 0) {
      handleCounts.delete(handle)
    } else {
      handleCounts.set(handle, after)
    }
  }

  function setLineage(paneKey: string, next: Lineage | undefined): void {
    const previous = lineageByPaneKey.get(paneKey)
    if (previous) {
      countHandle(previous.terminalHandle, -1)
      orchestratedThreads -= Number(previous.orchestration !== null)
    }
    if (next) {
      countHandle(next.terminalHandle, 1)
      orchestratedThreads += Number(next.orchestration !== null)
      lineageByPaneKey.set(paneKey, next)
    } else {
      lineageByPaneKey.delete(paneKey)
    }
  }

  /** Updates lineage for the dirty panes and reclassifies only when one could move a parent. */
  function refreshLineage(sources: AgentListVerdictSources, dirty: Set<string>): void {
    const hadOrchestration = orchestratedThreads > 0
    let lineageMoved = full
    for (const paneKey of dirty) {
      const thread = sources.thread(paneKey)
      const next = thread ? childAgentLineageInputs(thread) : undefined
      const previous = lineageByPaneKey.get(paneKey)
      if (
        previous?.terminalHandle === next?.terminalHandle &&
        previous?.orchestration === next?.orchestration &&
        (previous === undefined) === (next === undefined)
      ) {
        // With a handle reported twice, the newest pane wins it, so reordering alone can move a parent.
        lineageMoved ||= thread !== undefined && duplicateHandles > 0
        continue
      }
      setLineage(paneKey, next)
      lineageMoved = true
    }
    if (!lineageMoved || (!hadOrchestration && orchestratedThreads === 0 && !full)) {
      return
    }
    const next =
      orchestratedThreads > 0
        ? classifyChildAgents(sources.threads).parentPaneKeyByChild
        : new Map<string, string>()
    for (const [child, parent] of next) {
      if (parentByChild.get(child) !== parent) {
        dirty.add(child)
      }
    }
    for (const child of parentByChild.keys()) {
      if (!next.has(child)) {
        dirty.add(child)
      }
    }
    parentByChild = next
  }

  function verdictFor(
    paneKey: string,
    sources: AgentListVerdictSources
  ): AgentListVerdict | undefined {
    const thread = sources.thread(paneKey)
    if (thread) {
      const verdict = threadVerdict(thread)
      const childOf = parentByChild.get(paneKey)
      if (!childOf) {
        return verdict
      }
      return isRunningActivityState(thread.currentAgentState)
        ? { ...verdict, childOf }
        : { ...verdict, childOf, foldedChild: true }
    }
    const entry = sources.statuses.get(paneKey)
    if (!entry) {
      return undefined
    }
    // Read as the desktop's bot chat rows read it, so a closed chat's row on the phone agrees.
    return entry.state === 'done' && (sources.acknowledgedAt[paneKey] ?? 0) < entry.stateStartedAt
      ? { listed: false, unread: true }
      : { listed: false }
  }

  return {
    markPanes(paneKeys: Iterable<string>): void {
      for (const paneKey of paneKeys) {
        pending.add(paneKey)
      }
    },
    /** The next collect re-reads every pane. */
    markAll(): void {
      full = true
    },
    collect(sources: AgentListVerdictSources): AgentListVerdictChanges {
      let dirty = pending
      pending = new Set()
      if (full) {
        dirty = new Set(verdicts.keys())
        for (const paneKey of sources.statuses.keys()) {
          dirty.add(paneKey)
        }
        for (const thread of sources.threads) {
          dirty.add(thread.paneKey)
        }
        for (const paneKey of lineageByPaneKey.keys()) {
          dirty.add(paneKey)
        }
      }
      refreshLineage(sources, dirty)
      full = false
      const changes: AgentListVerdictChanges = { changed: {}, removed: [] }
      for (const paneKey of dirty) {
        const next = verdictFor(paneKey, sources)
        const previous = verdicts.get(paneKey)
        if (!next) {
          if (previous) {
            verdicts.delete(paneKey)
            changes.removed.push(paneKey)
          }
        } else if (!previous || !sameVerdict(previous, next)) {
          verdicts.set(paneKey, next)
          changes.changed[paneKey] = next
        }
      }
      return changes
    },
    snapshot(): Record<string, AgentListVerdict> {
      return Object.fromEntries(verdicts)
    }
  }
}

export type AgentListVerdictTracker = ReturnType<typeof createAgentListVerdictTracker>
