import { detectAgentStatusFromTitle, isExplicitAgentStatusFresh } from '@/lib/agent-status'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import type { AgentStatus } from '../../../../shared/agent-detection'
import type { TerminalTab, Worktree } from '../../../../shared/types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStateHistoryEntry,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'

/**
 * Ordinal class for the "Smart" sort. Lower number = more attention-demanding.
 *   1 — Needs you (`blocked` / `waiting`)
 *   2 — Done (`done`, not interrupted)
 *   3 — Working (`working`)
 *   4 — Idle (no live entry, stale entry, or interrupted `done`)
 *
 * Class is the primary sort key; within a class the comparator falls back to
 * the resolved attention timestamp. See docs/smart-worktree-order-redesign.md.
 */
export type SmartClass = 1 | 2 | 3 | 4

/**
 * What surfaced a worktree into Class 1. Carried only for Class 1 results
 * because that's the only class the telemetry promotion event reports on.
 *   - `blocked` / `waiting`: hook entry in that state.
 *   - `title-heuristic`: no fresh hook entry; runtime pane title classified
 *     as `'permission'` by `detectAgentStatusFromTitle`.
 */
export type AttentionCause = 'blocked' | 'waiting' | 'title-heuristic'

/**
 * Per-worktree resolution computed once before sorting.
 *
 * `attentionTimestamp` semantics depend on the class:
 *   - Class 1 / 2: `stateStartedAt` of the current entry (when the agent
 *     entered the attention state).
 *   - Class 3: `stateStartedAt` of the most recent prior `done`/`blocked`/
 *     `waiting` entry in `stateHistory[]`, falling back to the current
 *     `working` `stateStartedAt` when no prior attention event exists.
 *   - Class 4: `0` — the comparator drops to `effectiveRecentActivity` for
 *     within-class ordering on idle worktrees.
 *
 * `cause` is set only when `cls === 1`, and reflects the input that won the
 * within-class max-timestamp comparison. Used for the
 * `smart_sort_class_1_promotion` telemetry event.
 */
export type WorktreeAttention = {
  cls: SmartClass
  attentionTimestamp: number
  cause?: AttentionCause
}

export const IDLE: WorktreeAttention = { cls: 4, attentionTimestamp: 0 }

/**
 * Walk a pane's state-history rows and return the timestamp of the most
 * recent `done`/`blocked`/`waiting` entry, ignoring `done` rows that were
 * interrupted (the user pressed Ctrl+C — that turn no longer demands
 * attention). Returns `null` when no qualifying row exists.
 */
export function mostRecentAttentionInHistory(history: AgentStateHistoryEntry[]): number | null {
  let max = 0
  for (const h of history) {
    // Why: setAgentStatus preserves `interrupted` on history rows when an
    // interrupted `done` transitions out, so we can filter on history the
    // same way the current entry does.
    if (h.state === 'done' && h.interrupted) {
      continue
    }
    if (h.state === 'done' || h.state === 'blocked' || h.state === 'waiting') {
      // Why: NaN is silently skipped by `>`, but Infinity from a corrupted
      // row would pin the worktree at the top of Class 3 forever. Treat
      // non-finite values as missing.
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
 * One pane's contribution to a worktree's attention class. Hook entries from
 * `agentStatusByPaneKey` are authoritative when fresh; otherwise we fall back
 * to the terminal-title heuristic for hookless agents (Edge case 9 in the
 * design doc). Hook authority is per-pane, not per-worktree — a worktree with
 * a fresh hook on pane A and only a title on pane B mixes both branches.
 */
export type PaneInput =
  | { kind: 'hook'; entry: AgentStatusEntry }
  // Why: TerminalTab has no per-tab lastActivityAt; the worktree-level value
  // is enough since within-class ordering compares across worktrees.
  | { kind: 'title'; status: AgentStatus | null; worktreeLastActivityAt: number }

/**
 * Resolve a worktree's class + attention timestamp from its panes' inputs.
 * Stale hook entries (older than `AGENT_STATUS_STALE_AFTER_MS`) are skipped
 * — the worktree falls to Class 4 if no fresh hook entry and no recognized
 * title heuristic exists.
 *
 * Across multiple panes:
 *   - `cls` is the **min** (most attention-demanding pane wins).
 *   - `attentionTimestamp` is the **max** within the resolved class.
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
      // Why: defensive guard. NaN/Infinity from a corrupted stateStartedAt would
      // poison comparisons (NaN > anything === false), silently dropping the
      // worktree to the bottom of its class. Treat as a missing entry.
      if (!Number.isFinite(entry.stateStartedAt)) {
        continue
      }

      if (entry.state === 'blocked' || entry.state === 'waiting') {
        cls = 1
        ts = entry.stateStartedAt
        cause = entry.state
      } else if (entry.state === 'done') {
        // Why: an interrupted `done` (user pressed Ctrl+C) is the user signalling
        // "I'm done with this turn". Treat as idle, not as Class 2 attention.
        if (entry.interrupted) {
          continue
        }
        cls = 2
        ts = entry.stateStartedAt
      } else {
        // working
        cls = 3
        // Why: within Class 3, sort by the most recent prior attention event so
        // a worktree that just transitioned done→working stays above one that's
        // been working for an hour. Falls back to the current stateStartedAt
        // when stateHistory is empty (e.g. fresh after restart).
        const prior = mostRecentAttentionInHistory(entry.stateHistory)
        ts = prior ?? entry.stateStartedAt
      }
    } else {
      // Title-heuristic fallback (no fresh hook entry for this pane). Hook
      // wins when fresh; this branch only fires for hookless panes.
      if (pane.status === 'permission') {
        cls = 1
        // Why now: the title detector exposes no stateStartedAt. Using `now`
        // pins the worktree to the top of Class 1 until a hook event or the
        // next sort, matching the user's "just noticed" mental model.
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

    // Why min on class: smaller class number = higher priority. Any pane in a
    // more attention-demanding class promotes the whole worktree. Within the
    // same class, take the max timestamp so the freshest attention event wins.
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
 * Build a `tabId → entries[]` index over `agentStatusByPaneKey`. Entries are
 * keyed by the `tabId` prefix of their paneKey (paneKey format:
 * `${tabId}:${paneId}`). Doing this once per sort lets each worktree's
 * resolution pay O(T) lookups instead of scanning the full map.
 */
export function buildExplicitEntriesByTabId(
  agentStatusByPaneKey: Record<string, AgentStatusEntry> | undefined
): Map<string, AgentStatusEntry[]> {
  const byTab = new Map<string, AgentStatusEntry[]>()
  if (!agentStatusByPaneKey) {
    return byTab
  }
  for (const entry of Object.values(agentStatusByPaneKey)) {
    const colon = entry.paneKey.indexOf(':')
    // Why: paneKey must be `${tabId}:${paneId}`. Skip malformed entries (no
    // colon or leading colon) rather than bucketing them under an empty tabId.
    if (colon <= 0) {
      continue
    }
    const tabId = entry.paneKey.slice(0, colon)
    const bucket = byTab.get(tabId)
    if (bucket) {
      bucket.push(entry)
    } else {
      byTab.set(tabId, [entry])
    }
  }
  return byTab
}

/**
 * Extract the paneId from a `${tabId}:${paneId}` paneKey, returning null for
 * malformed keys (no colon or non-numeric tail). Used for per-pane authority:
 * we need to know which paneIds already have a fresh hook entry so we don't
 * double-count them via the title fallback.
 */
function paneIdFromPaneKey(paneKey: string): number | null {
  const colon = paneKey.indexOf(':')
  if (colon <= 0) {
    return null
  }
  const id = Number(paneKey.slice(colon + 1))
  return Number.isFinite(id) ? id : null
}

/**
 * Build the per-worktree attention map consumed by the smart comparator.
 *
 * Hook authority is per-pane: each pane that has a fresh hook entry uses it;
 * each pane without one falls back to the title heuristic when its runtime
 * pane title (or tab title for unmounted tabs) maps to a known status. The
 * title branch is gated on `tabHasLivePty` so slept tabs whose preserved
 * titles still match a working pattern don't leak through.
 *
 * Cost: O(E + N × T × H) where E = total entries, N = worktrees, T = tabs per
 * worktree, H = history length (bounded at AGENT_STATE_HISTORY_MAX = 20).
 */
export function buildAttentionByWorktree(
  worktrees: Worktree[],
  tabsByWorktree: Record<string, TerminalTab[]> | null,
  agentStatusByPaneKey: Record<string, AgentStatusEntry> | undefined,
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>,
  ptyIdsByTabId: Record<string, string[]>,
  now: number
): Map<string, WorktreeAttention> {
  const byTab = buildExplicitEntriesByTabId(agentStatusByPaneKey)
  const result = new Map<string, WorktreeAttention>()

  for (const worktree of worktrees) {
    const tabs = tabsByWorktree?.[worktree.id]
    if (!tabs || tabs.length === 0) {
      result.set(worktree.id, IDLE)
      continue
    }
    const panes: PaneInput[] = []
    for (const tab of tabs) {
      const hookEntries = byTab.get(tab.id)
      // Why: paneIds covered by a hook entry skip the title fallback so we
      // don't double-count them. Hook authority is per-pane.
      const hookPaneIds = new Set<number>()
      if (hookEntries) {
        for (const entry of hookEntries) {
          panes.push({ kind: 'hook', entry })
          // Why: only fresh hook entries should suppress the title-heuristic
          // fallback for their pane. A stale hook is filtered out by
          // resolveAttention; if we marked its pane as "hook-covered" we'd hide
          // the live title behind a dead entry and drop the worktree to Class 4.
          if (!isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)) {
            continue
          }
          const paneId = paneIdFromPaneKey(entry.paneKey)
          if (paneId !== null) {
            hookPaneIds.add(paneId)
          }
        }
      }

      // Why gate on tabHasLivePty: runtimePaneTitlesByTabId is preserved under
      // sleep (keepIdentifiers), so a slept tab whose pane titles still match
      // a working pattern would otherwise leak into the comparator.
      if (!tabHasLivePty(ptyIdsByTabId, tab.id)) {
        continue
      }

      const paneTitles = runtimePaneTitlesByTabId[tab.id]
      if (paneTitles && Object.keys(paneTitles).length > 0) {
        // Why: split-pane tabs can host multiple agents; each pane reports
        // its own title. Mirrors the precedence used by getWorkingAgentsPerWorktree.
        for (const [paneIdStr, title] of Object.entries(paneTitles)) {
          const paneId = Number(paneIdStr)
          if (hookPaneIds.has(paneId)) {
            continue
          }
          panes.push({
            kind: 'title',
            status: detectAgentStatusFromTitle(title),
            worktreeLastActivityAt: worktree.lastActivityAt
          })
        }
      } else if (hookPaneIds.size === 0) {
        // Why: tabs we have not mounted yet (restored-but-unvisited) only
        // expose the legacy tab title. Fall back to it only when no pane-level
        // titles or hook entries exist for this tab.
        panes.push({
          kind: 'title',
          status: detectAgentStatusFromTitle(tab.title),
          worktreeLastActivityAt: worktree.lastActivityAt
        })
      }
    }
    result.set(worktree.id, resolveAttention(panes, now))
  }

  return result
}
