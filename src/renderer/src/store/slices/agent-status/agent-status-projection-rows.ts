import type { AppState } from '../../types'
import {
  parseAgentStatusPaneIdentity,
  resolveAgentStatusWorktreeId,
  mergeAgentStatusOrchestration
} from '../../../../../shared/agent-status/identity/agent-status-worktree-attribution'
import { liveEntryWorktreeId } from '@/components/sidebar/workspace-card/activity/worktree-agent-live-index-patch'
import { buildExplicitWorktreeAgentRows } from '@/components/sidebar/workspace-card/activity/worktree-agent-rows'
import { tabFromWorktreeAttributedStatusEntry } from '@/components/sidebar/workspace-card/activity/worktree-agent-row-fallback-tab'
import { agentEntrySessionStartedAt } from '../../../../../shared/agent-session/lifecycle/agent-session-start-time'
import { isAgentStatusFresh } from '../../../../../shared/agent-status/contracts/agent-status-freshness'
import { applyAgentPaneActivityFlags } from '../../../../../shared/worktree-status-rollup'
import { resolveAttention, IDLE } from '../../../../../shared/sidebar-list/smart-attention'
import { classifyPaneKeyLiveness } from './agent-status-capacity-eviction'
import {
  parsePaneKey,
  makePaneKey,
  parseLegacyNumericPaneKey
} from '../../../../../shared/workspace-layout/stable-pane-id'
import { resolveRuntimePaneTitleLeafId } from '../../../../../shared/runtime-pane-title-leaf-id'
import {
  FLAGS,
  emptySummary,
  type Contribution,
  type PreparedRow
} from './agent-status-projection-types'
import type { AgentStatusProjectionState } from './agent-status-projection-state'
import type { ProjectionTopology } from './agent-status-projection-topology'

export function stageProjectionRows(
  data: AgentStatusProjectionState,
  state: AppState,
  topology: ProjectionTopology
) {
  const { changedKeys, nextTabs, represented, now, nextFallback, ownerOf, sourceEntry } = topology
  const nextSuppressions = new Map<string, readonly string[]>(),
    suppressionDeltas = new Map<string, number>()
  const delta = (key: string, sign: number) =>
    suppressionDeltas.set(key, (suppressionDeltas.get(key) ?? 0) + sign)
  for (const key of changedKeys) {
    for (const suppressed of data.suppressionsBySource.get(key) ?? []) {
      delta(suppressed, -1)
    }
    const entry = sourceEntry(key),
      keys: string[] = []
    const identity = parseAgentStatusPaneIdentity(key, represented.get(key))
    if (entry && identity) {
      keys.push(key)
      const legacy = parseLegacyNumericPaneKey(key),
        leaf = legacy
          ? resolveRuntimePaneTitleLeafId(
              state.terminalLayoutsByTabId[legacy.tabId],
              legacy.numericPaneId
            )
          : null
      if (leaf) {
        keys.push(makePaneKey(legacy!.tabId, leaf))
      }
      const orchestration = mergeAgentStatusOrchestration(
        entry,
        state.runtimeAgentOrchestrationByPaneKey[key]
      )
      const parent = orchestration?.parentPaneKey
      const parsed = parent ? parsePaneKey(parent) : null
      const owner = resolveAgentStatusWorktreeId(entry, { get: ownerOf }, orchestration)
      if (entry.state === 'done' && parsed && owner && ownerOf(parsed.tabId) === owner) {
        keys.push(parent!)
      }
    }
    nextSuppressions.set(key, keys)
    for (const suppressed of keys) {
      delta(suppressed, 1)
    }
  }
  for (const key of suppressionDeltas.keys()) {
    changedKeys.add(key)
  }
  const prepared = new Map<string, PreparedRow>(),
    classifier = classifyPaneKeyLiveness(state.terminalLayoutsByTabId)
  for (const key of changedKeys) {
    const accepted = state.agentStatusByPaneKey.get(key),
      entry = sourceEntry(key)
    const identity = parseAgentStatusPaneIdentity(key, represented.get(key)),
      tabId = identity?.tabId
    const worktreeId = entry
      ? liveEntryWorktreeId(key, entry, { get: ownerOf }, represented)
      : tabId
        ? ownerOf(tabId)
        : undefined
    const tab = tabId
      ? nextTabs.has(tabId)
        ? nextTabs.get(tabId)
        : data.tabs.get(tabId)
      : undefined
    const fallback = nextFallback.has(key) ? nextFallback.get(key) : data.fallbackRows.get(key)
    const displayTab = entry
      ? (tab ??
        tabFromWorktreeAttributedStatusEntry(
          entry,
          agentEntrySessionStartedAt(entry),
          represented.get(key)
        ))
      : tab
    const hasLivePty = Boolean(tabId && state.ptyIdsByTabId[tabId]?.length)
    const suppressed = (data.suppressed.get(key) ?? 0) + (suppressionDeltas.get(key) ?? 0) > 0
    const rows =
      entry && displayTab && worktreeId
        ? buildExplicitWorktreeAgentRows(
            entry,
            displayTab,
            now,
            hasLivePty,
            state.runtimeAgentOrchestrationByPaneKey
          )
        : fallback && worktreeId && !suppressed
          ? [fallback]
          : []
    let contribution: Contribution | undefined
    const summaryWorktreeId = entry
      ? resolveAgentStatusWorktreeId(
          entry,
          { get: ownerOf },
          mergeAgentStatusOrchestration(entry, state.runtimeAgentOrchestrationByPaneKey[key])
        )
      : undefined
    if (entry && summaryWorktreeId && identity) {
      const flags = emptySummary(),
        panes: string[] = [],
        stale: string[] = [],
        fresh = isAgentStatusFresh(entry, now)
      if (entry.restoredUnconfirmed || fresh) {
        panes.push(`${identity.tabId}\0${identity.paneId}`)
      } else {
        stale.push(`${identity.tabId}\0${identity.paneId}`)
      }
      if (!accepted) {
        flags.hasPermission = true
      } else if (!entry.restoredUnconfirmed && fresh) {
        applyAgentPaneActivityFlags(flags, entry)
        const parent =
          entry.state === 'done'
            ? parseAgentStatusPaneIdentity(
                mergeAgentStatusOrchestration(entry, state.runtimeAgentOrchestrationByPaneKey[key])
                  ?.parentPaneKey
              )
            : null
        if (parent && ownerOf(parent.tabId) === summaryWorktreeId) {
          panes.push(`${parent.tabId}\0${parent.paneId}`)
        }
      }
      contribution = {
        worktreeId: summaryWorktreeId,
        flags: FLAGS.filter((flag) => flags[flag]),
        panes,
        stale,
        attention: resolveAttention([{ kind: 'hook', entry, hasLivePty }], now),
        fresh
      }
    }
    if (!entry && rows.length && worktreeId) {
      contribution = {
        worktreeId,
        flags: [],
        panes: [],
        stale: [],
        attention: IDLE,
        titleState: rows[0].state
      }
    }
    const liveness = accepted ? classifier(key) : 'live'
    prepared.set(key, {
      rows,
      worktreeId,
      contribution,
      tabId,
      ...(accepted && !accepted.paneSleep && liveness !== 'live'
        ? { candidate: { updatedAt: accepted.updatedAt, dead: liveness === 'dead' } }
        : {})
    })
  }
  return { prepared, nextSuppressions, suppressionDeltas }
}
export type ProjectionRows = ReturnType<typeof stageProjectionRows>
