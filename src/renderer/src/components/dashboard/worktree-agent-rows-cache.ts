import type {
  AgentStatusEntry,
  AgentStatusOrchestrationContext,
  MigrationUnsupportedPtyEntry
} from '../../../../shared/agent-status-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import { migrationUnsupportedToAgentStatusEntry } from '@/lib/migration-unsupported-agent-entry'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import type { AppState } from '@/store/types'
import { applyAgentRowLineage, type DashboardAgentRowWithLineage } from './agent-row-lineage'
import { buildWorktreeAgentRows } from '../sidebar/worktree-agent-rows'
import {
  selectLiveAgentStatusEntriesForWorktree,
  selectMigrationUnsupportedEntriesForWorktree,
  selectRetainedAgentEntriesForWorktree,
  selectTerminalLayoutsForWorktree
} from '../sidebar/worktree-agent-row-selectors'
import {
  selectLivePtyIdsForWorktree,
  selectRuntimePaneTitlesForWorktree
} from '../sidebar/worktree-card-status-inputs'

type WorktreeAgentRowsCacheEntry = {
  /** Caller-provided invalidation token for time-based freshness (agentStatusEpoch). */
  generation: unknown
  liveEntries: AgentStatusEntry[]
  migrationUnsupported: MigrationUnsupportedPtyEntry[]
  retained: RetainedAgentEntry[]
  tabs: TerminalTab[] | undefined
  orchestration: Record<string, AgentStatusOrchestrationContext>
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot | undefined>
  paneTitlesByTabId: Record<string, Record<number, string>>
  ptyIdsByTabId: Record<string, string[]>
  rows: DashboardAgentRowWithLineage[]
}

/**
 * Per-worktree cache for the lineage-applied agent-row pipeline shared by the
 * dashboard snapshot and the sidebar bucket counts. Rows rerun only when one of
 * that worktree's own inputs changed — the indexed selectors keep untouched
 * worktrees' arrays referentially stable — so an unrelated status/title write
 * recomputes one worktree instead of all of them.
 *
 * Rows depend on wall-clock freshness, so `generation` (agentStatusEpoch) must
 * change whenever decay may have shifted a row state.
 */
export type WorktreeAgentRowsCache = {
  byWorktree: Map<string, WorktreeAgentRowsCacheEntry>
  /** Test instrumentation: cumulative per-worktree row-pipeline (re)computations. */
  computeCount: number
  /** Test instrumentation: worktree ids recomputed since the last startPass. */
  lastComputedWorktreeIds: string[]
  /** Worktree ids requested since the last startPass; finishPass evicts the rest. */
  seenWorktreeIds: Set<string>
}

export function createWorktreeAgentRowsCache(): WorktreeAgentRowsCache {
  return {
    byWorktree: new Map(),
    computeCount: 0,
    lastComputedWorktreeIds: [],
    seenWorktreeIds: new Set()
  }
}

/** Begin one full pass over the active workspaces (resets pass-scoped tracking). */
export function startWorktreeAgentRowsCachePass(cache: WorktreeAgentRowsCache): void {
  cache.lastComputedWorktreeIds = []
  cache.seenWorktreeIds.clear()
}

/** Drop cache rows for workspaces the pass did not visit so the map stays bounded. */
export function finishWorktreeAgentRowsCachePass(cache: WorktreeAgentRowsCache): void {
  for (const worktreeId of cache.byWorktree.keys()) {
    if (!cache.seenWorktreeIds.has(worktreeId)) {
      cache.byWorktree.delete(worktreeId)
    }
  }
}

export type WorktreeAgentRowsState = Pick<
  AppState,
  | 'agentStatusByPaneKey'
  | 'migrationUnsupportedByPtyId'
  | 'retainedAgentsByPaneKey'
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'ptyIdsByTabId'
  | 'runtimePaneTitlesByTabId'
> &
  Partial<Pick<AppState, 'unifiedTabsByWorktree'>>

// Why not identity: the per-worktree layout/title/ptyId selectors build a fresh top-level
// record per call while preserving per-tab value references, so shallow equality is the
// correct (and cheap — bounded by tabs per worktree) comparison.
function shallowRecordEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  if (a === b) {
    return true
  }
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) {
    return false
  }
  return aKeys.every((key) => Object.is(a[key], b[key]))
}

/** The lineage-applied rows for one worktree, reused by identity when its inputs are unchanged. */
export function selectWorktreeAgentRowsCached(args: {
  state: WorktreeAgentRowsState
  worktreeId: string
  orchestration: Record<string, AgentStatusOrchestrationContext>
  now: number
  generation: unknown
  cache?: WorktreeAgentRowsCache
}): DashboardAgentRowWithLineage[] {
  const { state, worktreeId, orchestration, now, generation, cache } = args
  cache?.seenWorktreeIds.add(worktreeId)
  const liveEntries = selectLiveAgentStatusEntriesForWorktree(state, worktreeId)
  const migrationUnsupported = selectMigrationUnsupportedEntriesForWorktree(state, worktreeId)
  const retained = selectRetainedAgentEntriesForWorktree(state, worktreeId)
  const tabs = state.tabsByWorktree[worktreeId]
  const terminalLayoutsByTabId = selectTerminalLayoutsForWorktree(state, worktreeId)
  const paneTitlesByTabId = selectRuntimePaneTitlesForWorktree(state, worktreeId)
  const ptyIdsByTabId = selectLivePtyIdsForWorktree(state, worktreeId)

  const cached = cache?.byWorktree.get(worktreeId)
  if (
    cached &&
    cached.generation === generation &&
    cached.liveEntries === liveEntries &&
    cached.migrationUnsupported === migrationUnsupported &&
    cached.retained === retained &&
    cached.tabs === tabs &&
    cached.orchestration === orchestration &&
    shallowRecordEqual(cached.terminalLayoutsByTabId, terminalLayoutsByTabId) &&
    shallowRecordEqual(cached.paneTitlesByTabId, paneTitlesByTabId) &&
    shallowRecordEqual(cached.ptyIdsByTabId, ptyIdsByTabId)
  ) {
    return cached.rows
  }

  const entries =
    migrationUnsupported.length > 0
      ? [
          ...liveEntries,
          ...migrationUnsupported.flatMap((unsupported) => {
            const entry = migrationUnsupportedToAgentStatusEntry(unsupported)
            return entry ? [entry] : []
          })
        ]
      : liveEntries
  const rows = applyAgentRowLineage(
    buildWorktreeAgentRows({
      tabs: tabs ?? [],
      entries,
      retained,
      runtimePaneTitlesByTabId: paneTitlesByTabId,
      ptyIdsByTabId,
      terminalLayoutsByTabId,
      runtimeAgentOrchestrationByPaneKey: orchestration,
      now
    })
  )
  if (cache) {
    cache.computeCount += 1
    cache.lastComputedWorktreeIds.push(worktreeId)
    cache.byWorktree.set(worktreeId, {
      generation,
      liveEntries,
      migrationUnsupported,
      retained,
      tabs,
      orchestration,
      terminalLayoutsByTabId,
      paneTitlesByTabId,
      ptyIdsByTabId,
      rows
    })
  }
  return rows
}
