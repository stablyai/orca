import {
  agentStatusValues,
  type AgentStatusRows
} from '../../agent-status/contracts/agent-status-rows'
import { detectAgentStatusFromTitle } from '../../agent-status/title/agent-title-status'
import {
  isAgentStatusFresh,
  AGENT_STATUS_STALE_AFTER_MS,
  agentStatusEvidenceObservedAt
} from '../../agent-status/contracts/agent-status-freshness'
import { agentEntryCompletionAt } from '../../agent-status/lifecycle/agent-completion-time'
import { agentTurnEndedOnPurpose } from '../../agent-status/lifecycle/agent-main-agent-verdict'
import { migrationUnsupportedToAgentStatusEntry } from '../../agent-status/presentation/migration-unsupported-agent-entry'
import { resolveDecayedAgentRowState } from '../../agent-status/presentation/agent-row-decay-state'
import { tabHasLivePty } from '../../workspace-layout/terminal-surfaces/tab-has-live-pty'
import { isSyntheticAgentPermissionTitle } from '../../agent-status/title/synthetic-agent-title'
import { resolveRuntimePaneTitleLeafId } from '../../workspace-layout/terminal-topology/runtime-pane-title-leaf-id'
import type { AgentStatus } from '../../agent-status/title/agent-title-core'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../workspace-layout/terminal-tab-types'

import type { AgentStateHistoryEntry } from '../../agent-status/lifecycle/agent-state-history'
import type { AgentStatusEntry } from '../../agent-status/contracts/agent-status-types'
import type { MigrationUnsupportedPtyEntry } from '../../agent-status/contracts/agent-status-ipc-payload'
import { parsePaneKey } from '../../workspace-layout/stable-pane-id'

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
  agentStatusByPaneKey: AgentStatusRows | undefined,
  now: number,
  tabsByWorktree: Record<string, readonly SmartAttentionTab[]>
): boolean {
  const freshUnstampedTabIds = new Set<string>()
  for (const entry of agentStatusValues(agentStatusByPaneKey)) {
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

  return bestCls === 5 && bestTs === 0 ? IDLE : { cls: bestCls, attentionTimestamp: bestTs }
}

/** Index entries by parsed tab ID once per sort, avoiding a full agent-map scan for each worktree. */
export function buildExplicitEntriesByTabId(
  agentStatusByPaneKey: AgentStatusRows | undefined,
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
  for (const entry of agentStatusValues(agentStatusByPaneKey)) {
    pushEntry(entry)
  }
  if (migrationUnsupportedByPtyId) {
    for (const ptyId in migrationUnsupportedByPtyId) {
      if (!Object.hasOwn(migrationUnsupportedByPtyId, ptyId)) {
        continue
      }
      const agentEntry = migrationUnsupportedToAgentStatusEntry(migrationUnsupportedByPtyId[ptyId])
      if (agentEntry) {
        pushEntry(agentEntry)
      }
    }
  }
  return byTab
}

export function buildExplicitEntriesByWorktreeId(
  agentStatusByPaneKey: AgentStatusRows | undefined
): Map<string, AgentStatusEntry[]> {
  const byWorktree = new Map<string, AgentStatusEntry[]>()
  for (const entry of agentStatusValues(agentStatusByPaneKey)) {
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
  const tabEntries = sources.entriesByTabId.get(tab.id)
  const hasLivePty = tabHasLivePty(sources.ptyIdsByTabId, tab.id)
  if (!hasLivePty && (!tabEntries || tabEntries.length === 0)) {
    return []
  }
  const panes: PaneInput[] = []
  // Why: leaves covered by a hook entry skip the title fallback so we don't double-count them.
  let hookLeafIds: Set<string> | undefined
  // Stale hooks still suppress one-shot permission titles, matching worktree and tab status dots.
  let permissionHookLeafIds: Set<string> | undefined
  if (tabEntries) {
    for (let i = 0; i < tabEntries.length; i += 1) {
      const entry = tabEntries[i]
      panes.push({ kind: 'hook', entry, hasLivePty })
      if (!hasLivePty) {
        continue
      }
      const leafId = leafIdFromPaneKey(entry.paneKey)
      if (leafId !== null) {
        ;(permissionHookLeafIds ??= new Set()).add(leafId)
      }
      // Why: restored rows own their co-restored title without asserting live state.
      if (
        !entry.restoredUnconfirmed &&
        !isAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)
      ) {
        continue
      }
      if (leafId !== null) {
        ;(hookLeafIds ??= new Set()).add(leafId)
      }
    }
  }

  // Why: runtimePaneTitlesByTabId survives sleep, so a slept tab's stale working-pattern title would leak in without this gate.
  if (!hasLivePty) {
    return panes
  }

  const paneTitles = sources.runtimePaneTitlesByTabId[tab.id]
  const paneTitleEntries = paneTitles ? Object.entries(paneTitles) : undefined
  if (!paneTitleEntries || paneTitleEntries.length === 0) {
    const coveredLeafIds = isSyntheticAgentPermissionTitle(tab.title)
      ? permissionHookLeafIds
      : hookLeafIds
    if (!coveredLeafIds || coveredLeafIds.size === 0) {
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
  for (let i = 0; i < paneTitleEntries.length; i += 1) {
    const [runtimePaneId, title] = paneTitleEntries[i]
    const coveredLeafIds = isSyntheticAgentPermissionTitle(title)
      ? permissionHookLeafIds
      : hookLeafIds
    const leafId = resolveRuntimePaneTitleLeafId(tabLayout, runtimePaneId)
    const hasSingleUnmappedHook =
      leafId === null && coveredLeafIds?.size === 1 && paneTitleEntries.length === 1
    if ((leafId !== null && coveredLeafIds?.has(leafId)) || hasSingleUnmappedHook) {
      continue
    }
    panes.push({ kind: 'title', status: detectAgentStatusFromTitle(title), worktreeLastActivityAt })
  }
  return panes
}
