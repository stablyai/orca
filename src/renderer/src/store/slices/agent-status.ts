import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  AGENT_STATE_HISTORY_MAX,
  type AgentStateHistoryEntry,
  type AgentStatusEntry,
  type AgentType,
  type ParsedAgentStatusPayload
} from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/types'

/** Snapshot of a finished (or vanished) agent status entry, kept around so
 *  the dashboard + sidebar hover can continue showing the completion until the
 *  user acknowledges it by clicking the worktree. The `worktreeId` is stamped
 *  at retention time so we know where the row belongs even after the tab/pty
 *  it came from has gone away. */
export type RetainedAgentEntry = {
  entry: AgentStatusEntry
  worktreeId: string
  /** Snapshot of the tab the agent lived in at retention time. We keep the
   *  full record (not just an id) because the tab may be gone from
   *  `tabsByWorktree` by the time the retained row is rendered. */
  tab: TerminalTab
  agentType: AgentType
  startedAt: number
}

export type AgentStatusSlice = {
  /** Explicit agent status entries keyed by `${tabId}:${paneId}` composite.
   *  Real-time only — lives in renderer memory, not persisted to disk. */
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  /** Monotonic tick that advances when agent-status freshness boundaries pass. */
  agentStatusEpoch: number

  /** Retained "done" entries — snapshots of agents that have disappeared from
   *  `agentStatusByPaneKey`. Keyed by paneKey so re-appearance of the same pane
   *  overwrites the snapshot. Shared between the dashboard and the sidebar
   *  agent-status hover so the two surfaces display identical rows. */
  retainedAgentsByPaneKey: Record<string, RetainedAgentEntry>

  /** Update or insert an agent status entry from a status payload. */
  setAgentStatus: (
    paneKey: string,
    payload: ParsedAgentStatusPayload,
    terminalTitle?: string
  ) => void

  /** Remove a single entry (e.g., when a pane's terminal exits). */
  removeAgentStatus: (paneKey: string) => void

  /** Remove all entries whose paneKey starts with the given prefix.
   *  Used when a tab is closed — same prefix-sweep as cacheTimerByKey cleanup. */
  removeAgentStatusByTabPrefix: (tabIdPrefix: string) => void

  /** Retain an agent snapshot (called by the top-level retention sync effect). */
  retainAgent: (retained: RetainedAgentEntry) => void

  /** Dismiss a retained entry by its paneKey. */
  dismissRetainedAgent: (paneKey: string) => void

  /** Dismiss all retained entries belonging to a worktree. */
  dismissRetainedAgentsByWorktree: (worktreeId: string) => void

  /** Prune retained entries whose worktreeId is not in the given set. */
  pruneRetainedAgents: (validWorktreeIds: Set<string>) => void
}

export const createAgentStatusSlice: StateCreator<AppState, [], [], AgentStatusSlice> = (
  set,
  get
) => {
  // Why: tests that call setAgentStatus must use vi.useFakeTimers() or remove the entry before teardown — otherwise a real 30-minute setTimeout leaks into the test process.
  let staleExpiryTimer: ReturnType<typeof setTimeout> | null = null

  const clearStaleExpiryTimer = (): void => {
    if (staleExpiryTimer !== null) {
      clearTimeout(staleExpiryTimer)
      staleExpiryTimer = null
    }
  }

  const scheduleNextFreshnessExpiry = (): void => {
    clearStaleExpiryTimer()

    const entries = Object.values(get().agentStatusByPaneKey)
    if (entries.length === 0) {
      return
    }

    const now = Date.now()
    let nextExpiryAt = Number.POSITIVE_INFINITY
    // Why: skip entries already past the stale boundary — they each contribute
    // exactly one epoch bump at crossing, and rescheduling on them would spin
    // the timer forever because the bump doesn't clear them from the map
    // (retention is intentional so freshness-aware selectors can decay).
    for (const entry of entries) {
      const expiryAt = entry.updatedAt + AGENT_STATUS_STALE_AFTER_MS
      if (expiryAt > now) {
        nextExpiryAt = Math.min(nextExpiryAt, expiryAt)
      }
    }
    if (!Number.isFinite(nextExpiryAt)) {
      return
    }

    // Why: +1 ms ensures the timer fires strictly after the stale boundary,
    // so isExplicitAgentStatusFresh (which uses `<=`) flips to stale when the
    // timer runs. Without the +1, float/rounding could leave the entry "just
    // fresh enough" at the tick, delaying the epoch bump by one tick.
    const delayMs = nextExpiryAt - now + 1
    staleExpiryTimer = setTimeout(() => {
      staleExpiryTimer = null
      // Why: freshness is time-based, not event-based. Advancing these epochs
      // at the exact stale boundary forces all freshness-aware selectors to
      // recompute — and re-sorts WorktreeList — even when no new PTY output
      // arrives. sortEpoch must bump in lockstep with agentStatusEpoch because
      // a stale transition can legitimately change worktree ordering.
      set((s) => ({
        agentStatusEpoch: s.agentStatusEpoch + 1,
        sortEpoch: s.sortEpoch + 1
      }))
      scheduleNextFreshnessExpiry()
    }, delayMs)
  }

  return {
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    retainedAgentsByPaneKey: {},

    setAgentStatus: (paneKey, payload, terminalTitle) => {
      set((s) => {
        const existing = s.agentStatusByPaneKey[paneKey]
        // Why: terminalTitle is identity-like — it labels the pane itself, not
        // the current turn's activity. Preserve the prior value when a ping
        // omits it so the pane label does not flicker out between hook events.
        // Unlike the tool/prompt/assistant fields below (which legitimately
        // clear on a fresh turn), a missing title means "no update", not "the
        // pane has no title any more".
        const effectiveTitle = terminalTitle ?? existing?.terminalTitle

        // Why: build up a rolling log of state transitions so the dashboard can
        // render activity blocks showing what the agent has been doing. Only push
        // when the state actually changes to avoid duplicate entries from prompt-
        // only updates within the same state.
        let history: AgentStateHistoryEntry[] = existing?.stateHistory ?? []
        if (existing && existing.state !== payload.state) {
          history = [
            ...history,
            {
              state: existing.state,
              prompt: existing.prompt,
              // Why: use stateStartedAt (not updatedAt) so the history row
              // reflects when the state was first reported, not the most
              // recent within-state ping (tool/prompt updates refresh
              // updatedAt but not stateStartedAt).
              startedAt: existing.stateStartedAt,
              // Why: preserve the interrupt flag on the historical `done` entry
              // so activity-block views can render past cancellations as such.
              interrupted: existing.interrupted
            }
          ]
          if (history.length > AGENT_STATE_HISTORY_MAX) {
            history = history.slice(history.length - AGENT_STATE_HISTORY_MAX)
          }
        }

        const now = Date.now()
        // Why: stateStartedAt anchors to the first time this state was
        // reported. Carry forward the prior value on tool/prompt pings within
        // the same state so stateHistory[].startedAt reflects true state-onset
        // (see AgentStatusEntry.stateStartedAt docs).
        const stateStartedAt =
          existing && existing.state === payload.state ? existing.stateStartedAt : now

        // Why: tool/assistant fields come pre-merged from the main-process
        // cache (see `resolveToolState` in server.ts), so the payload always
        // carries the authoritative current snapshot — including clears on a
        // fresh turn. Writing through directly (no existing fallback) is what
        // lets a `UserPromptSubmit` reset clear stale tool lines in the UI.
        const entry: AgentStatusEntry = {
          state: payload.state,
          prompt: payload.prompt,
          updatedAt: now,
          stateStartedAt,
          // Why: unlike tool/prompt/assistant fields (which legitimately clear on a
          // fresh turn), agentType is the agent's identity for the pane — it does
          // not change between updates. Preserve the prior value when a payload
          // omits it so the icon/label does not flicker out between hook pings.
          // 'unknown' is the sentinel for "agent didn't identify itself" in
          // WellKnownAgentType. Treat it like absence so a well-known prior
          // identity (e.g. 'claude' learned from an earlier hook ping) isn't
          // stomped by a later ping that lost the identity (e.g. legacy/partial
          // integrations).
          agentType:
            payload.agentType && payload.agentType !== 'unknown'
              ? payload.agentType
              : existing?.agentType,
          paneKey,
          terminalTitle: effectiveTitle,
          stateHistory: history,
          toolName: payload.toolName,
          toolInput: payload.toolInput,
          lastAssistantMessage: payload.lastAssistantMessage,
          // Why: interrupted lives on `done` only. parseAgentStatusPayload
          // already clamps it to `undefined` for non-done states, so writing
          // the field through directly preserves truth for done and resets
          // it when a new turn starts (working → Stop reprices it).
          interrupted: payload.interrupted
        }
        return {
          agentStatusByPaneKey: { ...s.agentStatusByPaneKey, [paneKey]: entry },
          // Why: bump both epochs so WorktreeCard re-derives its visual status
          // and WorktreeList re-sorts immediately when an agent reports status.
          // The freshness-expiry timer and the remove* paths bump both epochs
          // for the same reason — agent transitions (new, stale, removed) can
          // all legitimately change worktree sort order.
          agentStatusEpoch: s.agentStatusEpoch + 1,
          sortEpoch: s.sortEpoch + 1
        }
      })
      // Why: schedule after set completes so the timer reads the updated map.
      // queueMicrotask avoids re-entry into the zustand store during set.
      queueMicrotask(() => scheduleNextFreshnessExpiry())
    },

    removeAgentStatus: (paneKey) => {
      if (!(paneKey in get().agentStatusByPaneKey)) {
        return
      }
      set((s) => {
        const next = { ...s.agentStatusByPaneKey }
        delete next[paneKey]
        // Why: bump sortEpoch in lockstep with agentStatusEpoch — removing an
        // agent can legitimately change worktree sort order, same rationale
        // as setAgentStatus.
        return {
          agentStatusByPaneKey: next,
          agentStatusEpoch: s.agentStatusEpoch + 1,
          sortEpoch: s.sortEpoch + 1
        }
      })
      queueMicrotask(() => scheduleNextFreshnessExpiry())
    },

    removeAgentStatusByTabPrefix: (tabIdPrefix) => {
      const prefix = `${tabIdPrefix}:`
      const currentKeys = Object.keys(get().agentStatusByPaneKey)
      const toRemove = currentKeys.filter((k) => k.startsWith(prefix))
      if (toRemove.length === 0) {
        return
      }
      set((s) => {
        const next = { ...s.agentStatusByPaneKey }
        for (const key of toRemove) {
          delete next[key]
        }
        // Why: bump sortEpoch in lockstep with agentStatusEpoch — removing
        // agents can legitimately change worktree sort order, same rationale
        // as setAgentStatus. The pre-check guards against spurious bumps when
        // no keys matched the prefix.
        return {
          agentStatusByPaneKey: next,
          agentStatusEpoch: s.agentStatusEpoch + 1,
          sortEpoch: s.sortEpoch + 1
        }
      })
      queueMicrotask(() => scheduleNextFreshnessExpiry())
    },

    retainAgent: (retained) => {
      // Why: retained entries are a pure read-overlay — consumers read
      // retainedAgentsByPaneKey directly each render, so no sort/status epoch
      // bump is needed. Retention does not participate in sort ordering.
      set((s) => ({
        retainedAgentsByPaneKey: {
          ...s.retainedAgentsByPaneKey,
          [retained.entry.paneKey]: retained
        }
      }))
    },

    dismissRetainedAgent: (paneKey) => {
      set((s) => {
        if (!(paneKey in s.retainedAgentsByPaneKey)) {
          return s
        }
        const next = { ...s.retainedAgentsByPaneKey }
        delete next[paneKey]
        return { retainedAgentsByPaneKey: next }
      })
    },

    dismissRetainedAgentsByWorktree: (worktreeId) => {
      set((s) => {
        let changed = false
        const next: Record<string, RetainedAgentEntry> = {}
        for (const [key, ra] of Object.entries(s.retainedAgentsByPaneKey)) {
          if (ra.worktreeId === worktreeId) {
            changed = true
            continue
          }
          next[key] = ra
        }
        return changed ? { retainedAgentsByPaneKey: next } : s
      })
    },

    pruneRetainedAgents: (validWorktreeIds) => {
      set((s) => {
        let changed = false
        const next: Record<string, RetainedAgentEntry> = {}
        for (const [key, ra] of Object.entries(s.retainedAgentsByPaneKey)) {
          if (!validWorktreeIds.has(ra.worktreeId)) {
            changed = true
            continue
          }
          next[key] = ra
        }
        return changed ? { retainedAgentsByPaneKey: next } : s
      })
    }
  }
}
