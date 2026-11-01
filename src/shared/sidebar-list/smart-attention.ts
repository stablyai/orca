import { detectAgentStatusFromTitle } from '../agent-detection'
import { isAgentStatusFresh } from '../agent-status-freshness'
import { agentEntryCompletionAt } from '../agent-completion-time'
import { agentTurnEndedOnPurpose } from '../agent-main-agent-verdict'
import { migrationUnsupportedToAgentStatusEntry } from '../migration-unsupported-agent-entry'
import { resolveDecayedAgentRowState } from '../agent-row-decay-state'
import { tabHasLivePty } from '../tab-has-live-pty'
import { isSyntheticAgentPermissionTitle } from '../synthetic-agent-title'
import { resolveRuntimePaneTitleLeafId } from '../runtime-pane-title-leaf-id'
import type { AgentStatus } from '../agent-detection'
import type { TerminalLayoutSnapshot, TerminalTab } from '../terminal-tab-types'
import type { Worktree } from '../worktree/types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  agentStatusEvidenceObservedAt,
  type AgentStateHistoryEntry,
  type AgentStatusEntry,
  type MigrationUnsupportedPtyEntry
} from '../agent-status-types'
import { parsePaneKey } from '../stable-pane-id'

/** Attention priority: 1 Needs you; 2 recent unrequested Done; 3 Working; 4 stale evidence with a live PTY;
 * 5 Idle (including stopped/aged Done or stale without live PTY). Lower wins; ties use attention timestamps.
 * See docs/smart-worktree-order-redesign.md. */
export type SmartClass = 1 | 2 | 3 | 4 | 5

/** Per-sort resolution. Timestamps: needs-you entry start; Done completion; Working latest prior attention
 * (or current start); unverifiable last evidence; Idle zero falls through to effectiveRecentActivity. */
export type WorktreeAttention = {
  cls: SmartClass
  attentionTimestamp: number
}

export const IDLE: WorktreeAttention = { cls: 5, attentionTimestamp: 0 }

/** The tab fields attention reads, so main can score from its own tab records. */
export type SmartAttentionTab = Pick<TerminalTab, 'id' | 'title'>

export function hasFreshAttributedAgentStatus(
  agentStatusByPaneKey: Record<string, AgentStatusEntry> | undefined,
  now: number,
  tabsByWorktree: Record<string, readonly SmartAttentionTab[]>
): boolean {
  const freshUnstampedTabIds = new Set<string>()
  for (const entry of Object.values(agentStatusByPaneKey ?? {})) {
    const parsed = parsePaneKey(entry.paneKey)
    if (parsed === null || !isAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)) {
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

/** Latest prior Done/blocked/waiting timestamp, excluding user-stopped turns; null when none qualifies. */
export function mostRecentAttentionInHistory(history: AgentStateHistoryEntry[]): number | null {
  let max = 0
  for (const h of history) {
    // Why: history rows keep the verdict, so filter a stopped turn like the current entry.
    if (h.state === 'done' || h.state === 'blocked' || h.state === 'waiting') {
      // Why: Infinity from a corrupted row would pin the worktree atop Class 3 forever; treat non-finite as missing.
      if (agentTurnEndedOnPurpose(h) || !Number.isFinite(h.startedAt)) {
        continue
      }
      if (h.startedAt > max) {
        max = h.startedAt
      }
    }
  }
  return max > 0 ? max : null
}

/** Fresh hooks outrank title heuristics per pane, never for an entire worktree. */
export type PaneInput =
  // Retained PTY evidence distinguishes a lost reporting stream from an empty pane.
  | { kind: 'hook'; entry: AgentStatusEntry; hasLivePty: boolean }
  // Why: TerminalTab has no per-tab lastActivityAt; the worktree-level value suffices for cross-worktree ordering.
  | { kind: 'title'; status: AgentStatus | null; worktreeLastActivityAt: number }

/** Choose the most demanding pane (minimum class), then latest timestamp within it. Stale hooks decay
 * to unverifiable with live PTY evidence, otherwise Idle; absent fresh hooks/titles also mean Idle. */
export function resolveAttention(panes: PaneInput[], now: number): WorktreeAttention {
  let bestCls: SmartClass = 5
  let bestTs = 0

  for (const pane of panes) {
    let cls: SmartClass
    let ts: number

    if (pane.kind === 'hook') {
      const entry = pane.entry
      if (!isAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)) {
        // Retained PTYs outrank empty panes without claiming completion or outranking reporting panes.
        if (resolveDecayedAgentRowState(entry, pane.hasLivePty) === 'unverifiable') {
          const observedAt = agentStatusEvidenceObservedAt(entry)
          if (
            Number.isFinite(observedAt) &&
            (4 < bestCls || (bestCls === 4 && observedAt > bestTs))
          ) {
            bestCls = 4
            bestTs = observedAt
          }
        }
        continue
      }
      // Why: non-finite stateStartedAt (NaN/Infinity) would poison comparisons; treat as a missing entry.
      if (!Number.isFinite(entry.stateStartedAt)) {
        continue
      }

      if (entry.state === 'blocked' || entry.state === 'waiting') {
        cls = 1
        ts = entry.stateStartedAt
      } else if (entry.state === 'done') {
        // User stops/idle session boundaries are not attention; failed completions remain unseen news.
        const completedAt = agentEntryCompletionAt(entry)
        if (completedAt === null) {
          continue
        }
        // updatedAt can advance on same-state Done writes; gate completion age separately to match the UI.
        if (now - completedAt > AGENT_STATUS_STALE_AFTER_MS) {
          continue
        }
        cls = 2
        ts = completedAt
      } else {
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
      } else if (pane.status === 'working') {
        cls = 3
        ts = pane.worktreeLastActivityAt
      } else {
        continue
      }
    }

    // Min class wins (higher priority); tie-break on max timestamp so the freshest attention event wins.
    if (cls < bestCls || (cls === bestCls && ts > bestTs)) {
      bestCls = cls
      bestTs = ts
    }
  }

  return { cls: bestCls, attentionTimestamp: bestTs }
}

/** Index entries by parsed tab ID once per sort, avoiding a full agent-map scan for each worktree. */
export function buildExplicitEntriesByTabId(
  agentStatusByPaneKey: Record<string, AgentStatusEntry> | undefined,
  migrationUnsupportedByPtyId?: Record<string, MigrationUnsupportedPtyEntry>
): Map<string, AgentStatusEntry[]> {
  const byTab = new Map<string, AgentStatusEntry[]>()
  const pushEntry = (entry: AgentStatusEntry): void => {
    const parsed = parsePaneKey(entry.paneKey)
    // Why: skip malformed/legacy-numeric paneKeys rather than bucketing unroutable rows under a tab.
    if (!parsed) {
      return
    }
    const bucket = byTab.get(parsed.tabId)
    if (bucket) {
      bucket.push(entry)
    } else {
      byTab.set(parsed.tabId, [entry])
    }
  }
  for (const entry of Object.values(agentStatusByPaneKey ?? {})) {
    pushEntry(entry)
  }
  for (const entry of Object.values(migrationUnsupportedByPtyId ?? {})) {
    const agentEntry = migrationUnsupportedToAgentStatusEntry(entry)
    if (agentEntry) {
      pushEntry(agentEntry)
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

/** Use hook rows plus uncovered title heuristics; live-PTY gating excludes stale slept-tab titles. */
export function collectTabPaneInputs(
  tab: SmartAttentionTab,
  worktreeLastActivityAt: number,
  sources: TabPaneInputSources,
  now: number
): PaneInput[] {
  const panes: PaneInput[] = []
  const hasLivePty = tabHasLivePty(sources.ptyIdsByTabId, tab.id)
  // Why: leaves covered by a hook entry skip the title fallback so we don't double-count them.
  const hookLeafIds = new Set<string>()
  // Stale hooks still suppress one-shot permission titles, matching worktree and tab status dots.
  const permissionHookLeafIds = new Set<string>()
  for (const entry of sources.entriesByTabId.get(tab.id) ?? []) {
    panes.push({ kind: 'hook', entry, hasLivePty })
    const leafId = leafIdFromPaneKey(entry.paneKey)
    if (leafId !== null) {
      permissionHookLeafIds.add(leafId)
    }
    // Why: restored rows own their co-restored title without asserting live state.
    if (
      !entry.restoredUnconfirmed &&
      !isAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)
    ) {
      continue
    }
    if (leafId !== null) {
      hookLeafIds.add(leafId)
    }
  }

  // Why: runtimePaneTitlesByTabId survives sleep, so a slept tab's stale working-pattern title would leak in without this gate.
  if (!hasLivePty) {
    return panes
  }

  const paneTitles = sources.runtimePaneTitlesByTabId[tab.id]
  if (!paneTitles || Object.keys(paneTitles).length === 0) {
    const coveredLeafIds = isSyntheticAgentPermissionTitle(tab.title)
      ? permissionHookLeafIds
      : hookLeafIds
    if (coveredLeafIds.size === 0) {
      // Why: unmounted tabs (restored-but-unvisited) expose only the legacy tab title.
      panes.push({
        kind: 'title',
        status: detectAgentStatusFromTitle(tab.title),
        worktreeLastActivityAt
      })
    }
    return panes
  }

  // Why: split-pane tabs host multiple agents, one title each; mirrors getWorkingAgentsPerWorktree precedence.
  const tabLayout = sources.terminalLayoutsByTabId?.[tab.id]
  const paneTitleEntries = Object.entries(paneTitles)
  for (const [runtimePaneId, title] of paneTitleEntries) {
    const coveredLeafIds = isSyntheticAgentPermissionTitle(title)
      ? permissionHookLeafIds
      : hookLeafIds
    const leafId = resolveRuntimePaneTitleLeafId(tabLayout, runtimePaneId)
    const hasSingleUnmappedHook =
      leafId === null && coveredLeafIds.size === 1 && paneTitleEntries.length === 1
    if ((leafId !== null && coveredLeafIds.has(leafId)) || hasSingleUnmappedHook) {
      continue
    }
    panes.push({ kind: 'title', status: detectAgentStatusFromTitle(title), worktreeLastActivityAt })
  }
  return panes
}

/** Resolve attention once per workspace with per-pane hook authority and live-PTY-gated title fallbacks. */
export function buildAttentionByWorktree(
  worktrees: readonly Pick<Worktree, 'id' | 'lastActivityAt'>[],
  tabsByWorktree: Record<string, readonly SmartAttentionTab[]> | null,
  agentStatusByPaneKey: Record<string, AgentStatusEntry> | undefined,
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>,
  ptyIdsByTabId: Record<string, string[]>,
  now: number,
  migrationUnsupportedByPtyId?: Record<string, MigrationUnsupportedPtyEntry>,
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot>
): Map<string, WorktreeAttention> {
  const byTab = buildExplicitEntriesByTabId(agentStatusByPaneKey, migrationUnsupportedByPtyId)
  const byAttributedWorktree = buildExplicitEntriesByWorktreeId(agentStatusByPaneKey)
  const mirroredTabIds = new Set<string>()
  for (const tabs of Object.values(tabsByWorktree ?? {})) {
    for (const tab of tabs) {
      mirroredTabIds.add(tab.id)
    }
  }
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
      // No mirrored tab means no renderer live-PTY evidence to hold these hooks above Idle.
      .map((entry) => ({ kind: 'hook' as const, entry, hasLivePty: false }))
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
