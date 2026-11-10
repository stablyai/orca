import type { WorktreeAgentActivitySummary } from './worktree-agent-activity-summary'
import { getTabIdToWorktreeId } from './worktree-agent-row-selectors'
import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import {
  mergeAgentStatusOrchestration,
  parseAgentStatusPaneIdentity
} from '../../../../../../shared/agent-status/identity/agent-status-worktree-attribution'
import { applyAgentPaneActivityFlags } from '../../../../../../shared/worktree-status-rollup'

type SleepSummary = {
  entries: AgentStatusEntry[]
  tabs: AppState['tabsByWorktree'][string] | undefined
  contexts: (AppState['runtimeAgentOrchestrationByPaneKey'][string] | undefined)[]
  summary: WorktreeAgentActivitySummary
}
let sleepSummaryCache = new Map<string, SleepSummary>()
let sleepSummarySource: Map<string, AgentStatusEntry[]> | undefined
let previousTabs: AppState['tabsByWorktree'] | undefined
let previousOrchestration: AppState['runtimeAgentOrchestrationByPaneKey'] | undefined
let sleepSummaries = new Map<string, WorktreeAgentActivitySummary>()
export function getSleepSummaries(
  source: Map<string, AgentStatusEntry[]>,
  empty: WorktreeAgentActivitySummary,
  tabs: AppState['tabsByWorktree'],
  orchestration: AppState['runtimeAgentOrchestrationByPaneKey'] | undefined
): Map<string, WorktreeAgentActivitySummary> {
  if (
    source === sleepSummarySource &&
    previousTabs === tabs &&
    previousOrchestration === orchestration
  ) {
    return sleepSummaries
  }
  const owners = getTabIdToWorktreeId(tabs)
  const nextCache = new Map<string, SleepSummary>()
  const next = new Map<string, WorktreeAgentActivitySummary>()
  for (const [owner, entries] of source) {
    const previous = sleepSummaryCache.get(owner)
    if (
      previous?.entries === entries &&
      previous.tabs === tabs[owner] &&
      (previousOrchestration === orchestration ||
        entries.every((entry, i) => previous.contexts[i] === orchestration?.[entry.paneKey]))
    ) {
      nextCache.set(owner, previous)
      next.set(owner, previous.summary)
      continue
    }
    const summary = { ...empty }
    for (const entry of entries) {
      const pane = parseAgentStatusPaneIdentity(entry.paneKey)
      if (!pane) {
        continue
      }
      summary.agentStatusPaneIdsByTabId = {
        ...summary.agentStatusPaneIdsByTabId,
        [pane.tabId]: new Set([
          ...(summary.agentStatusPaneIdsByTabId[pane.tabId] ?? []),
          pane.paneId
        ])
      }
      if (entry.state === 'done') {
        const parent = parseAgentStatusPaneIdentity(
          mergeAgentStatusOrchestration(entry, orchestration?.[entry.paneKey])?.parentPaneKey
        )
        if (parent && owners.get(parent.tabId) === owner) {
          summary.agentStatusPaneIdsByTabId[parent.tabId] = new Set([
            ...(summary.agentStatusPaneIdsByTabId[parent.tabId] ?? []),
            parent.paneId
          ])
        }
      }
      applyAgentPaneActivityFlags(summary, entry)
    }
    nextCache.set(owner, {
      entries,
      tabs: tabs[owner],
      contexts: entries.map((entry) => orchestration?.[entry.paneKey]),
      summary
    })
    next.set(owner, summary)
  }
  sleepSummaryCache = nextCache
  if (
    next.size !== sleepSummaries.size ||
    [...next].some(([owner, summary]) => sleepSummaries.get(owner) !== summary)
  ) {
    sleepSummaries = next
  }
  sleepSummarySource = source
  previousTabs = tabs
  previousOrchestration = orchestration
  return next
}
