import { classifyTitleActivity, isExplicitAgentStatusFresh } from '@/lib/pane-agent-evidence'
import { agentEntryCompletionAt } from '../../../../shared/agent-completion-time'
import { migrationUnsupportedToAgentStatusEntry } from '@/lib/migration-unsupported-agent-entry'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import { resolveRuntimePaneTitleLeafId } from '@/lib/runtime-pane-title-leaf-id'
import type { AgentStatus } from '../../../../shared/agent-detection'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStateHistoryEntry,
  type AgentStatusEntry,
  type MigrationUnsupportedPtyEntry
} from '../../../../shared/agent-status-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'

/**
 * Ordinal class for the "Smart" sort. Lower number = more attention-demanding.
 *   1 — Needs you (`blocked` / `waiting`)
 *   2 — Done (`done`, not interrupted, completed within AGENT_STATUS_STALE_AFTER_MS)
 *   3 — Working (`working`)
 *   4 — Idle (no live entry, stale entry, interrupted `done`, or an aged-out completion)
 *
 * Primary sort key; ties fall back to the attention timestamp. See docs/smart-worktree-order-redesign.md.
 */
export type SmartClass = 1 | 2 | 3 | 4

/**
 * What surfaced a worktree into Class 1 (carried only for Class 1, the only class telemetry reports on).
 *   - `blocked` / `waiting`: hook entry in that state.
 *   - `title-heuristic`: no fresh hook entry; runtime pane title classified as `'permission'`.
 */
export type AttentionCause = 'blocked' | 'waiting' | 'title-heuristic'

/**
 * Per-worktree resolution computed once before sorting.
 *
 * `attentionTimestamp` by class:
 *   - Class 1: `stateStartedAt` of the current entry. Class 2: the entry's completion time.
 *   - Class 3: `stateStartedAt` of the most recent prior `done`/`blocked`/`waiting` entry,
 *     falling back to the current `working` `stateStartedAt`.
 *   - Class 4: `0` — comparator drops to `effectiveRecentActivity` for idle ordering.
 *
 * `cause` is set only when `cls === 1`; feeds the `smart_sort_class_1_promotion` telemetry event.
 */
export type WorktreeAttention = {
  cls: SmartClass
  attentionTimestamp: number
  cause?: AttentionCause
}

export const IDLE: WorktreeAttention = { cls: 4, attentionTimestamp: 0 }

export function hasFreshAttributedAgentStatus(
  agentStatusByPaneKey: Record<string, AgentStatusEntry> | undefined,
  now: number,
  tabsByWorktree: Record<string, TerminalTab[]>
): boolean {
  const freshUnstampedTabIds = new Set<string>()
  for (const entry of Object.values(agentStatusByPaneKey ?? {})) {
    const parsed = parsePaneKey(entry.paneKey)
    if (parsed === null || !isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)) {
      continue
    }
    if (entry.worktreeId) {
      return true
    }
    // Why: hook rows can omit the worktree stamp but still map via paneKey to a mirrored tab — enough to end cold-start.
    freshUnstampedTabIds.add(parsed.tabId)
  }
  if (freshUnstampedTabIds.size === 0) {
    return false
  }
  return Object.values(tabsByWorktree).some((tabs) =>
    tabs.some((tab) => freshUnstampedTabIds.has(tab.id))
  )
}

/**
 * Return the timestamp of the most recent `done`/`blocked`/`waiting` history row, ignoring
 * interrupted `done` rows (Ctrl+C). Returns `null` when no qualifying row exists.
 */
export function mostRecentAttentionInHistory(history: AgentStateHistoryEntry[]): number | null {
  let max = 0
  for (const h of history) {
    // Why: setAgentStatus preserves `interrupted` on history rows, so filter them like the current entry.
    if (h.state === 'done' && h.interrupted) {
      continue
    }
    if (h.state === 'done' || h.state === 'blocked' || h.state === 'waiting') {
      // Why: Infinity from a corrupted row would pin the worktree atop Class 3 forever; treat non-finite as missing.
      if (!Number.isFinite(h.startedAt)) {
        continue
      }
      if (h.startedAt > max) {
        max = h.startedAt
      }
    }
  }
  return max > 0 ? max : null
}

/**
 * One pane's contribution to a worktree's attention class. Fresh hook entries win; hookless
 * panes fall back to the title heuristic (design doc Edge case 9). Authority is per-pane, not per-worktree.
 */
export type PaneInput =
  | { kind: 'hook'; entry: AgentStatusEntry }
  // Why: TerminalTab has no per-tab lastActivityAt; the worktree-level value suffices for cross-worktree ordering.
  | { kind: 'title'; status: AgentStatus | null; worktreeLastActivityAt: number }

/**
 * Resolve a worktree's class + attention timestamp from its panes' inputs.
 * Stale hook entries are skipped; the worktree falls to Class 4 with no fresh hook and no title heuristic.
 * Across panes: `cls` is the **min** (most demanding pane wins), `attentionTimestamp` the **max** within that class.
 */
export function resolveAttention(panes: PaneInput[], now: number): WorktreeAttention {
  let bestCls: SmartClass = 4
  let bestTs = 0
  let bestCause: AttentionCause | undefined

  for (const pane of panes) {
    let cls: SmartClass
    let ts: number
    let cause: AttentionCause | undefined

    if (pane.kind === 'hook') {
      const entry = pane.entry
      if (!isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)) {
        continue
      }
      // Why: non-finite stateStartedAt (NaN/Infinity) would poison comparisons; treat as a missing entry.
      if (!Number.isFinite(entry.stateStartedAt)) {
        continue
      }

      if (entry.state === 'blocked' || entry.state === 'waiting') {
        cls = 1
        ts = entry.stateStartedAt
        cause = entry.state
      } else if (entry.state === 'done') {
        // Why: null covers interrupted `done` (Ctrl+C — user is finished with it) and idle session
        // boundaries; neither is attention.
        const completedAt = agentEntryCompletionAt(entry)
        if (completedAt === null) {
          continue
        }
        // Why: same-state `done` writes advance updatedAt without moving the completion, so the hook
        // freshness gate alone can keep a row in Class 2 long after the UI shows it aged out.
        if (now - completedAt > AGENT_STATUS_STALE_AFTER_MS) {
          continue
        }
        cls = 2
        ts = completedAt
      } else {
        // working
        cls = 3
        // Why: sort Class 3 by most recent prior attention so a just-started turn outranks one working for an hour.
        const prior = mostRecentAttentionInHistory(entry.stateHistory)
        if (prior === null) {
          ts = entry.stateStartedAt
        } else if (entry.agentType === 'command-code') {
          // Why: Command Code has no UserPromptSubmit hook; a new prompt only bumps stateStartedAt, so max beats stale prior-attention.
          ts = Math.max(prior, entry.stateStartedAt)
        } else {
          ts = prior
        }
      }
    } else {
      // Title-heuristic fallback: only fires for panes with no fresh hook entry.
      if (pane.status === 'permission') {
        cls = 1
        // Why now: title detector exposes no stateStartedAt; `now` pins it to the top of Class 1 until a hook event.
        ts = now
        cause = 'title-heuristic'
      } else if (pane.status === 'working') {
        cls = 3
        ts = pane.worktreeLastActivityAt
      } else {
        // 'idle' or null: nothing to assert; pane stays in Class 4.
        continue
      }
    }

    // Min class wins (higher priority); tie-break on max timestamp so the freshest attention event wins.
    if (cls < bestCls || (cls === bestCls && ts > bestTs)) {
      bestCls = cls
      bestTs = ts
      bestCause = cause
    }
  }

  return bestCls === 1 && bestCause
    ? { cls: bestCls, attentionTimestamp: bestTs, cause: bestCause }
    : { cls: bestCls, attentionTimestamp: bestTs }
}

/**
 * Build a `tabId → entries[]` index over `agentStatusByPaneKey`, keyed by the paneKey's
 * `tabId` prefix. Built once per sort so each worktree's resolution is O(T), not a full-map scan.
 */
export function buildExplicitEntriesByTabId(
  agentStatusByPaneKey: Record<string, AgentStatusEntry> | undefined,
  migrationUnsupportedByPtyId?: Record<string, MigrationUnsupportedPtyEntry>
): Map<string, AgentStatusEntry[]> {
  const byTab = new Map<string, AgentStatusEntry[]>()
  const entries = [
    ...Object.values(agentStatusByPaneKey ?? {}),
    ...Object.values(migrationUnsupportedByPtyId ?? {}).flatMap((entry) => {
      const agentEntry = migrationUnsupportedToAgentStatusEntry(entry)
      return agentEntry ? [agentEntry] : []
    })
  ]
  if (entries.length === 0) {
    return byTab
  }
  for (const entry of entries) {
    const parsed = parsePaneKey(entry.paneKey)
    // Why: skip malformed/legacy-numeric paneKeys rather than bucketing unroutable rows under a tab.
    if (!parsed) {
      continue
    }
    const bucket = byTab.get(parsed.tabId)
    if (bucket) {
      bucket.push(entry)
    } else {
      byTab.set(parsed.tabId, [entry])
    }
  }
  return byTab
}

function buildExplicitEntriesByWorktreeId(
  agentStatusByPaneKey: Record<string, AgentStatusEntry> | undefined
): Map<string, AgentStatusEntry[]> {
  const byWorktree = new Map<string, AgentStatusEntry[]>()
  for (const entry of Object.values(agentStatusByPaneKey ?? {})) {
    if (!entry.worktreeId || !parsePaneKey(entry.paneKey)) {
      continue
    }
    const bucket = byWorktree.get(entry.worktreeId)
    if (bucket) {
      bucket.push(entry)
    } else {
      byWorktree.set(entry.worktreeId, [entry])
    }
  }
  return byWorktree
}

/**
 * Extract the stable leaf id from a `${tabId}:${leafId}` paneKey.
 */
function leafIdFromPaneKey(paneKey: string): string | null {
  return parsePaneKey(paneKey)?.leafId ?? null
}

/** Renderer state a single tab's panes are resolved from. */
export type TabPaneInputSources = {
  entriesByTabId: ReadonlyMap<string, AgentStatusEntry[]>
  ptyIdsByTabId: Record<string, string[]>
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot>
}

/**
 * One terminal tab's contribution to an attention resolution: its hook entries, plus the
 * title heuristic for panes no fresh hook covers. Gated on `tabHasLivePty` so a slept tab's
 * stale working-pattern title can't leak through.
 */
export function collectTabPaneInputs(
  tab: Pick<TerminalTab, 'id' | 'title'>,
  worktreeLastActivityAt: number,
  sources: TabPaneInputSources,
  now: number
): PaneInput[] {
  const panes: PaneInput[] = []
  // Why: leaves covered by a hook entry skip the title fallback so we don't double-count them.
  const hookLeafIds = new Set<string>()
  for (const entry of sources.entriesByTabId.get(tab.id) ?? []) {
    panes.push({ kind: 'hook', entry })
    // Why: restored rows own their co-restored title without asserting live state.
    if (
      !entry.restoredUnconfirmed &&
      !isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)
    ) {
      continue
    }
    const leafId = leafIdFromPaneKey(entry.paneKey)
    if (leafId !== null) {
      hookLeafIds.add(leafId)
    }
  }

  // Why: runtimePaneTitlesByTabId survives sleep, so a slept tab's stale working-pattern title would leak in without this gate.
  if (!tabHasLivePty(sources.ptyIdsByTabId, tab.id)) {
    return panes
  }

  const paneTitles = sources.runtimePaneTitlesByTabId[tab.id]
  if (!paneTitles || Object.keys(paneTitles).length === 0) {
    if (hookLeafIds.size === 0) {
      // Why: unmounted tabs (restored-but-unvisited) expose only the legacy tab title.
      panes.push({
        kind: 'title',
        status: classifyTitleActivity(tab.title),
        worktreeLastActivityAt
      })
    }
    return panes
  }

  // Why: split-pane tabs host multiple agents, one title each; mirrors getWorkingAgentsPerWorktree precedence.
  const tabLayout = sources.terminalLayoutsByTabId?.[tab.id]
  const paneTitleEntries = Object.entries(paneTitles)
  for (const [runtimePaneId, title] of paneTitleEntries) {
    const leafId = resolveRuntimePaneTitleLeafId(tabLayout, runtimePaneId)
    const hasSingleUnmappedHook =
      leafId === null && hookLeafIds.size === 1 && paneTitleEntries.length === 1
    if ((leafId !== null && hookLeafIds.has(leafId)) || hasSingleUnmappedHook) {
      continue
    }
    panes.push({ kind: 'title', status: classifyTitleActivity(title), worktreeLastActivityAt })
  }
  return panes
}

/**
 * Build the per-worktree attention map consumed by the smart comparator.
 * Hook authority is per-pane; panes without a fresh hook fall back to the title heuristic,
 * gated on `tabHasLivePty` so slept tabs' stale working-pattern titles don't leak through.
 */
export function buildAttentionByWorktree(
  worktrees: Worktree[],
  tabsByWorktree: Record<string, TerminalTab[]> | null,
  agentStatusByPaneKey: Record<string, AgentStatusEntry> | undefined,
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>,
  ptyIdsByTabId: Record<string, string[]>,
  now: number,
  migrationUnsupportedByPtyId?: Record<string, MigrationUnsupportedPtyEntry>,
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot>
): Map<string, WorktreeAttention> {
  const byTab = buildExplicitEntriesByTabId(agentStatusByPaneKey, migrationUnsupportedByPtyId)
  const byAttributedWorktree = buildExplicitEntriesByWorktreeId(agentStatusByPaneKey)
  const mirroredTabIds = new Set(
    Object.values(tabsByWorktree ?? {}).flatMap((tabs) => tabs.map((tab) => tab.id))
  )
  const paneSources: TabPaneInputSources = {
    entriesByTabId: byTab,
    ptyIdsByTabId,
    runtimePaneTitlesByTabId,
    terminalLayoutsByTabId
  }
  const result = new Map<string, WorktreeAttention>()

  for (const worktree of worktrees) {
    const tabs = tabsByWorktree?.[worktree.id] ?? []
    // Why: hook stamps can precede tab mirroring; once mirrored, live tab ownership wins so both worktrees aren't promoted.
    const panes: PaneInput[] = (byAttributedWorktree.get(worktree.id) ?? [])
      .filter((entry) => {
        const parsed = parsePaneKey(entry.paneKey)
        return parsed !== null && !mirroredTabIds.has(parsed.tabId)
      })
      .map((entry) => ({ kind: 'hook' as const, entry }))
    if (tabs.length === 0) {
      result.set(worktree.id, resolveAttention(panes, now))
      continue
    }
    for (const tab of tabs) {
      panes.push(...collectTabPaneInputs(tab, worktree.lastActivityAt, paneSources, now))
    }
    result.set(worktree.id, resolveAttention(panes, now))
  }

  return result
}
