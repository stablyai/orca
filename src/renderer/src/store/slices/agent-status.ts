/* eslint-disable max-lines -- Why: the agent-status slice co-locates live map, retained snapshots, retention-suppression, and tab-prefix sweep so the teardown contract stays readable end-to-end. Splitting across files would scatter the drop/remove/retain interactions that must stay in lockstep. */
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
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import { createFreshnessScheduler } from './agent-status-freshness-scheduler'

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

  /** Pane keys explicitly torn down (pane close, tab close, PTY exit, manual
   *  dismissal) and therefore forbidden from being re-retained on their next
   *  disappearance. Consumed by the retention sync as a one-shot suppressor. */
  retentionSuppressedPaneKeys: Record<string, true>

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

  /** Remove a single entry AND suppress re-retention on its next disappearance.
   *  Used for USER-INITIATED teardown — the dashboard/hover X button, and
   *  pane close — where the user is telling us "I'm done with this row". */
  dropAgentStatus: (paneKey: string) => void

  /** Remove all entries under a tab AND suppress re-retention for each.
   *  Used on tab close — the user is tearing down the whole tab, so any
   *  remaining agent rows (live or retained) must not reappear. */
  dropAgentStatusByTabPrefix: (tabIdPrefix: string) => void

  /** Remove all entries for a worktree AND suppress re-retention for live rows.
   *  Used on worktree sleep/remove — the whole worktree surface is folding, so
   *  retained rows must drop even if their original tab is no longer present.
   *
   *  Note on orphan-live asymmetry: liveKeys are matched against tab prefixes
   *  derived from `tabsByWorktree[worktreeId]`. Live entries belonging to the
   *  same worktree but whose tab has already been pruned from `tabsByWorktree`
   *  (an orphan-live race) are not swept here. The retained side has a
   *  fallback (`retained.worktreeId === worktreeId`); the live side does not,
   *  because live entries do not carry a worktreeId. In practice the gap is
   *  bounded — `removeAgentStatus` is called on PTY exit — and dropping an
   *  orphan-live entry on shutdown is best-effort, so accepting the asymmetry
   *  is the simpler tradeoff. */
  dropAgentStatusByWorktree: (worktreeId: string) => void

  /** Retain agent snapshots (called by the top-level retention sync effect).
   *  Accepts an array so multiple agents disappearing in the same frame
   *  produce a single set(...) — avoids intermediate states visible
   *  mid-loop to consumers. */
  retainAgents: (entries: RetainedAgentEntry[]) => void

  /** Dismiss a retained entry by its paneKey. */
  dismissRetainedAgent: (paneKey: string) => void

  /** Dismiss all retained entries belonging to a worktree. */
  dismissRetainedAgentsByWorktree: (worktreeId: string) => void

  /** Prune retained entries whose worktreeId is not in the given set. */
  pruneRetainedAgents: (validWorktreeIds: Set<string>) => void

  /** Clear one-shot teardown suppressors after the retention sync observes
   *  that disappearance and decides not to retain the row. */
  clearRetentionSuppressedPaneKeys: (paneKeys: string[]) => void
}

function paneKeyMatchesAnyTabPrefix(paneKey: string, tabPrefixes: string[]): boolean {
  for (const prefix of tabPrefixes) {
    if (paneKey.startsWith(prefix)) {
      return true
    }
  }
  return false
}

export const createAgentStatusSlice: StateCreator<AppState, [], [], AgentStatusSlice> = (
  set,
  get
) => {
  // Why: the freshness scheduler is intentionally process-lifetime-scoped —
  // no dispose path — because it matches the store's own lifetime model
  // (the zustand store is a module-level singleton that lives until process
  // exit). Adding a teardown hook would require a store-dispose lifecycle
  // that does not exist anywhere else in the codebase.
  const freshness = createFreshnessScheduler({
    getEntries: () => Object.values(get().agentStatusByPaneKey),
    bumpEpochs: () => {
      // Why: freshness is time-based, not event-based. Advancing these epochs
      // at the exact stale boundary forces all freshness-aware selectors to
      // recompute — and re-sorts WorktreeList — even when no new PTY output
      // arrives. sortEpoch must bump in lockstep with agentStatusEpoch because
      // a stale transition can legitimately change worktree ordering.
      set((s) => ({
        agentStatusEpoch: s.agentStatusEpoch + 1,
        sortEpoch: s.sortEpoch + 1
      }))
    }
  })

  return {
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    retainedAgentsByPaneKey: {},
    retentionSuppressedPaneKeys: {},

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
            (payload.agentType && payload.agentType !== 'unknown'
              ? payload.agentType
              : existing?.agentType) ?? 'unknown',
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
        // Why: `agentStatusEpoch` bumps on every update because visual +
        // freshness selectors (WorktreeCard status, hover content) care about
        // tool-name/prompt/assistant-message churn within a turn. `sortEpoch`,
        // on the other hand, bumps only when sort-relevant inputs change —
        // avoiding sidebar re-sorts on every tool/prompt event would stress
        // the smart-sort debounce for no reason. Sort-relevant inputs are:
        //   1. `state` transitions — sort score is a function of state.
        //   2. Freshness transitions (stale → fresh) — `computeSmartScoreFromSignals`
        //      in smart-sort.ts filters entries through
        //      `isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)`
        //      (30-min TTL). A stale entry that refreshes with the SAME state
        //      goes from "not contributing" to contributing +60 (working) or
        //      +35 (blocked/waiting) to the score — order must update. The new
        //      entry below always has `updatedAt = now`, so it is fresh; we
        //      only need to detect the stale→fresh flip on `existing`.
        const wasFresh =
          !!existing && isExplicitAgentStatusFresh(existing, now, AGENT_STATUS_STALE_AFTER_MS)
        const sortRelevantChange = !existing || existing.state !== payload.state || !wasFresh
        // Why: a new status event means the agent is live again — lift any
        // one-shot retention suppressor so the row can be retained normally
        // on its next disappearance. setAgentStatus fires on every PTY status
        // update (high frequency), so only clone retentionSuppressedPaneKeys
        // when there is actually a suppressor to remove — otherwise every
        // status ping would churn that map reference and force spurious
        // re-renders in any subscriber selecting on it.
        const hasSuppressor = paneKey in s.retentionSuppressedPaneKeys
        let nextRetentionSuppressedPaneKeys = s.retentionSuppressedPaneKeys
        if (hasSuppressor) {
          nextRetentionSuppressedPaneKeys = { ...s.retentionSuppressedPaneKeys }
          delete nextRetentionSuppressedPaneKeys[paneKey]
        }
        return {
          agentStatusByPaneKey: { ...s.agentStatusByPaneKey, [paneKey]: entry },
          retentionSuppressedPaneKeys: nextRetentionSuppressedPaneKeys,
          agentStatusEpoch: s.agentStatusEpoch + 1,
          sortEpoch: sortRelevantChange ? s.sortEpoch + 1 : s.sortEpoch
        }
      })
      // Why: schedule after set completes so the timer reads the updated map.
      // queueMicrotask avoids re-entry into the zustand store during set.
      queueMicrotask(() => freshness.schedule())
    },

    removeAgentStatus: (paneKey) => {
      if (!(paneKey in get().agentStatusByPaneKey)) {
        return
      }
      set((s) => {
        const next = { ...s.agentStatusByPaneKey }
        delete next[paneKey]
        // Why: acknowledgedAgentsByPaneKey is written per user-ack but owned
        // lifecycle-wise by the pane — drop the ack entry in lockstep with the
        // live-map entry so closed panes don't leave stale ack timestamps that
        // could silently suppress "unvisited" signals on future paneKey
        // collisions.
        let nextAck = s.acknowledgedAgentsByPaneKey
        if (paneKey in nextAck) {
          nextAck = { ...nextAck }
          delete nextAck[paneKey]
        }
        // Why: bump sortEpoch in lockstep with agentStatusEpoch — removing an
        // agent can legitimately change worktree sort order, same rationale
        // as setAgentStatus.
        return {
          agentStatusByPaneKey: next,
          ...(nextAck !== s.acknowledgedAgentsByPaneKey
            ? { acknowledgedAgentsByPaneKey: nextAck }
            : {}),
          agentStatusEpoch: s.agentStatusEpoch + 1,
          sortEpoch: s.sortEpoch + 1
        }
      })
      queueMicrotask(() => freshness.schedule())
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
        // See removeAgentStatus for rationale on ack cleanup.
        let nextAck = s.acknowledgedAgentsByPaneKey
        const ackKeys = Object.keys(nextAck).filter((k) => k.startsWith(prefix))
        if (ackKeys.length > 0) {
          nextAck = { ...nextAck }
          for (const k of ackKeys) {
            delete nextAck[k]
          }
        }
        // Why: bump sortEpoch in lockstep with agentStatusEpoch — removing
        // agents can legitimately change worktree sort order, same rationale
        // as setAgentStatus. The pre-check guards against spurious bumps when
        // no keys matched the prefix.
        return {
          agentStatusByPaneKey: next,
          ...(nextAck !== s.acknowledgedAgentsByPaneKey
            ? { acknowledgedAgentsByPaneKey: nextAck }
            : {}),
          agentStatusEpoch: s.agentStatusEpoch + 1,
          sortEpoch: s.sortEpoch + 1
        }
      })
      queueMicrotask(() => freshness.schedule())
    },

    dropAgentStatus: (paneKey) => {
      // Why: single sync read — zustand set is synchronous, so the value we
      // observe inside the set callback is the same one we would re-read via
      // get() immediately after. Capture it once from inside the callback
      // rather than double-reading the store before and during set.
      let liveExisted = false
      set((s) => {
        const hasLive = paneKey in s.agentStatusByPaneKey
        liveExisted = hasLive
        const hasRetained = paneKey in s.retainedAgentsByPaneKey
        // See removeAgentStatus for rationale on ack cleanup. Apply this
        // regardless of live/retained presence — the ack entry is owned by
        // the pane lifecycle independently of live/retained state.
        let nextAck = s.acknowledgedAgentsByPaneKey
        if (paneKey in nextAck) {
          nextAck = { ...nextAck }
          delete nextAck[paneKey]
        }
        // Why: bail when there is genuinely nothing to do. The old guard
        // `!hasLive && !hasRetained && alreadySuppressed` leaked a phantom
        // suppressor write in the `!hasLive && !hasRetained && !alreadySuppressed`
        // case. With the hasLive-gated suppressor below, a no-op drop on a
        // paneKey with no live and no retained entry truly has nothing to
        // change, so short-circuit here — but still flush a pending ack
        // cleanup if one is present.
        if (!hasLive && !hasRetained) {
          if (nextAck !== s.acknowledgedAgentsByPaneKey) {
            return { acknowledgedAgentsByPaneKey: nextAck }
          }
          return s
        }

        const nextLive = hasLive ? { ...s.agentStatusByPaneKey } : s.agentStatusByPaneKey
        if (hasLive) {
          delete nextLive[paneKey]
        }

        const nextRetained = hasRetained
          ? { ...s.retainedAgentsByPaneKey }
          : s.retainedAgentsByPaneKey
        if (hasRetained) {
          delete nextRetained[paneKey]
        }

        // Why: explicit teardown means "the user is done with this row", so
        // the next retention sync must not resurrect it from the previous frame.
        //
        // Why same-frame race is acceptable: if dropAgentStatus fires in the
        // same React frame as setAgentStatus, before useRetainedAgentsSync's
        // prevAgentsRef has captured the live entry, the planted suppressor
        // may never be consumed by a live→gone transition and would persist.
        // In practice suppressors are bounded by user-dismissed paneKeys (a
        // small set), so the leak is pragmatically inert — accepting it is
        // cheaper than threading frame-level ordering guarantees through the
        // retention sync.
        //
        // Why gate on hasLive: the suppressor is a one-shot flag consumed by
        // `collectRetainedAgentsOnDisappear` (useRetainedAgents.ts), which
        // iterates the PREVIOUS render's LIVE agents to decide what to
        // retain. If we dismiss a retained-only row (no live entry at drop
        // time), no live→gone transition will ever fire for this paneKey, so
        // the suppressor would never be consumed and would leak indefinitely
        // — only clearing if the same paneKey later became live again via
        // setAgentStatus. A retained-only dismissal just needs the retained
        // entry removed; there is no live-agent resurrection risk to guard
        // against. Only spread retentionSuppressedPaneKeys when hasLive.
        //
        // Why the `!(paneKey in s.retentionSuppressedPaneKeys)` check: if a
        // suppressor is already present, re-spreading produces a new object
        // reference with identical contents and spuriously re-renders any
        // subscriber selecting on retentionSuppressedPaneKeys. Mirror the
        // guard used in setAgentStatus.
        const needsSuppressorWrite = hasLive && !(paneKey in s.retentionSuppressedPaneKeys)

        return {
          agentStatusByPaneKey: nextLive,
          retainedAgentsByPaneKey: nextRetained,
          ...(nextAck !== s.acknowledgedAgentsByPaneKey
            ? { acknowledgedAgentsByPaneKey: nextAck }
            : {}),
          ...(needsSuppressorWrite
            ? {
                retentionSuppressedPaneKeys: {
                  ...s.retentionSuppressedPaneKeys,
                  [paneKey]: true
                }
              }
            : {}),
          agentStatusEpoch: hasLive ? s.agentStatusEpoch + 1 : s.agentStatusEpoch,
          // Why: mirrors removeAgentStatus — dropping a live working/blocked
          // agent changes its contribution to the worktree sort score, so the
          // sidebar smart-sort must recompute. Without this bump, a user-
          // initiated dismissal from the inline agents list would leave the
          // sidebar ordering stale until some unrelated event repaired it.
          sortEpoch: hasLive ? s.sortEpoch + 1 : s.sortEpoch
        }
      })
      // Why: freshness.schedule only matters when the live map changed —
      // retained-only and no-op drops don't touch it. Gate on the live
      // presence observed inside set() so a noop drop on a paneKey with no
      // live and no retained entry (or a retained-only dismissal) skips the
      // microtask.
      if (liveExisted) {
        queueMicrotask(() => freshness.schedule())
      }
    },

    dropAgentStatusByTabPrefix: (tabIdPrefix) => {
      const prefix = `${tabIdPrefix}:`
      let hadLive = false
      set((s) => {
        const liveKeys = Object.keys(s.agentStatusByPaneKey).filter((k) => k.startsWith(prefix))
        const retainedKeys = Object.keys(s.retainedAgentsByPaneKey).filter((k) =>
          k.startsWith(prefix)
        )
        // See removeAgentStatus for rationale on ack cleanup. Apply this
        // regardless of live/retained presence — ack entries are owned by
        // the pane lifecycle independently of live/retained state.
        let nextAck = s.acknowledgedAgentsByPaneKey
        const ackKeys = Object.keys(nextAck).filter((k) => k.startsWith(prefix))
        if (ackKeys.length > 0) {
          nextAck = { ...nextAck }
          for (const k of ackKeys) {
            delete nextAck[k]
          }
        }
        if (liveKeys.length === 0 && retainedKeys.length === 0) {
          if (nextAck !== s.acknowledgedAgentsByPaneKey) {
            return { acknowledgedAgentsByPaneKey: nextAck }
          }
          return s
        }
        hadLive = liveKeys.length > 0

        const nextLive =
          liveKeys.length > 0 ? { ...s.agentStatusByPaneKey } : s.agentStatusByPaneKey
        for (const key of liveKeys) {
          delete nextLive[key]
        }

        const nextRetained =
          retainedKeys.length > 0 ? { ...s.retainedAgentsByPaneKey } : s.retainedAgentsByPaneKey
        for (const key of retainedKeys) {
          delete nextRetained[key]
        }

        // Why: plant suppressors only for paneKeys that had a live entry,
        // mirroring the hasLive gate in dropAgentStatus — suppressors are
        // one-shot flags consumed by collectRetainedAgentsOnDisappear on a
        // live→gone transition, so a suppressor on a retained-only paneKey
        // would leak because no such transition will ever fire. Also skip
        // keys that are already suppressed so we don't spuriously reallocate
        // the suppressor map for subscribers that select on its identity.
        //
        // Same-frame race: if a hook ping promotes working→done in the same
        // render frame as teardown, the next retention-sync run sees the entry
        // as `done` in prevAgents and surfaces it in retained — even though
        // the user just tore it down. Planting suppressors is the cheap guard
        // for the common ordering; the rare inverse ordering has the same
        // bounded suppressor-leak tradeoff described in dropAgentStatus.
        const suppressorAdds = liveKeys.filter((k) => !(k in s.retentionSuppressedPaneKeys))
        let nextRetentionSuppressedPaneKeys = s.retentionSuppressedPaneKeys
        if (suppressorAdds.length > 0) {
          nextRetentionSuppressedPaneKeys = { ...s.retentionSuppressedPaneKeys }
          for (const key of suppressorAdds) {
            nextRetentionSuppressedPaneKeys[key] = true
          }
        }

        return {
          agentStatusByPaneKey: nextLive,
          retainedAgentsByPaneKey: nextRetained,
          retentionSuppressedPaneKeys: nextRetentionSuppressedPaneKeys,
          ...(nextAck !== s.acknowledgedAgentsByPaneKey
            ? { acknowledgedAgentsByPaneKey: nextAck }
            : {}),
          // Why: mirrors removeAgentStatusByTabPrefix — only bump the live-map
          // epoch / sortEpoch when the live map actually changed. Retained-only
          // sweeps do not participate in smart-sort or freshness calculations.
          agentStatusEpoch: hadLive ? s.agentStatusEpoch + 1 : s.agentStatusEpoch,
          sortEpoch: hadLive ? s.sortEpoch + 1 : s.sortEpoch
        }
      })
      if (hadLive) {
        queueMicrotask(() => freshness.schedule())
      }
    },

    dropAgentStatusByWorktree: (worktreeId) => {
      let hadLive = false
      set((s) => {
        const tabPrefixes = (s.tabsByWorktree[worktreeId] ?? []).map((tab) => `${tab.id}:`)
        const liveKeys = Object.keys(s.agentStatusByPaneKey).filter((k) =>
          paneKeyMatchesAnyTabPrefix(k, tabPrefixes)
        )
        const retainedKeys = Object.entries(s.retainedAgentsByPaneKey)
          .filter(
            ([paneKey, retained]) =>
              retained.worktreeId === worktreeId || paneKeyMatchesAnyTabPrefix(paneKey, tabPrefixes)
          )
          .map(([paneKey]) => paneKey)
        const retainedKeySet = new Set(retainedKeys)
        // See removeAgentStatus for rationale on ack cleanup. Current tabs are
        // swept by prefix; orphan retained rows are swept by their retained key.
        let nextAck = s.acknowledgedAgentsByPaneKey
        const ackKeys = Object.keys(nextAck).filter(
          (k) => paneKeyMatchesAnyTabPrefix(k, tabPrefixes) || retainedKeySet.has(k)
        )
        if (ackKeys.length > 0) {
          nextAck = { ...nextAck }
          for (const key of ackKeys) {
            delete nextAck[key]
          }
        }
        // Mirror dropAgentStatusByTabPrefix: when nothing live or retained
        // changed, narrow the return to just the ack delta (or s) so we don't
        // emit a new top-level state object that re-renders full-state
        // subscribers for nothing.
        if (liveKeys.length === 0 && retainedKeys.length === 0) {
          if (nextAck !== s.acknowledgedAgentsByPaneKey) {
            return { acknowledgedAgentsByPaneKey: nextAck }
          }
          return s
        }
        hadLive = liveKeys.length > 0

        const nextLive =
          liveKeys.length > 0 ? { ...s.agentStatusByPaneKey } : s.agentStatusByPaneKey
        for (const key of liveKeys) {
          delete nextLive[key]
        }

        const nextRetained =
          retainedKeys.length > 0 ? { ...s.retainedAgentsByPaneKey } : s.retainedAgentsByPaneKey
        for (const key of retainedKeys) {
          delete nextRetained[key]
        }

        // Why: a worktree-level teardown folds the whole surface. Current live
        // rows need one-shot suppressors so the retention sync cannot recreate a
        // done row from the previous render after sleep/remove has hidden it.
        const suppressorAdds = liveKeys.filter((k) => !(k in s.retentionSuppressedPaneKeys))
        let nextRetentionSuppressedPaneKeys = s.retentionSuppressedPaneKeys
        if (suppressorAdds.length > 0) {
          nextRetentionSuppressedPaneKeys = { ...s.retentionSuppressedPaneKeys }
          for (const key of suppressorAdds) {
            nextRetentionSuppressedPaneKeys[key] = true
          }
        }

        return {
          agentStatusByPaneKey: nextLive,
          retainedAgentsByPaneKey: nextRetained,
          retentionSuppressedPaneKeys: nextRetentionSuppressedPaneKeys,
          ...(nextAck !== s.acknowledgedAgentsByPaneKey
            ? { acknowledgedAgentsByPaneKey: nextAck }
            : {}),
          agentStatusEpoch: hadLive ? s.agentStatusEpoch + 1 : s.agentStatusEpoch,
          sortEpoch: hadLive ? s.sortEpoch + 1 : s.sortEpoch
        }
      })
      if (hadLive) {
        queueMicrotask(() => freshness.schedule())
      }
    },

    retainAgents: (entries) => {
      // Why: retained entries are a pure read-overlay — consumers read
      // retainedAgentsByPaneKey directly each render, so no sort/status epoch
      // bump is needed. Retention does not participate in sort ordering.
      // Batching into a single set(...) keeps multi-agent disappearance atomic.
      if (entries.length === 0) {
        return
      }
      set((s) => {
        // Why: skip the allocation + set(...) entirely when every input entry
        // is already present by reference. Consumers of retainedAgentsByPaneKey
        // select on its identity (the inline agents list), so a spurious map
        // reallocation forces re-renders even when nothing changed. Mirrors
        // the identity-preservation pattern used by pruneRetainedAgents and
        // clearRetentionSuppressedPaneKeys.
        let changed = false
        for (const retained of entries) {
          if (s.retainedAgentsByPaneKey[retained.entry.paneKey] !== retained) {
            changed = true
            break
          }
        }
        if (!changed) {
          return s
        }
        const next = { ...s.retainedAgentsByPaneKey }
        for (const retained of entries) {
          // Why: INVARIANT — the map key equals retained.entry.paneKey. This
          // lets callers look up a retained row by the same paneKey they use
          // for agentStatusByPaneKey and keeps dismissal (dismissRetainedAgent)
          // keyed on a single identifier. collectRetainedAgentsOnDisappear
          // relies on this invariant too: it checks
          // `retainedAgentsByPaneKey[paneKey]` to decide whether a vanished
          // agent is already retained.
          next[retained.entry.paneKey] = retained
        }
        return { retainedAgentsByPaneKey: next }
      })
    },

    dismissRetainedAgent: (paneKey) => {
      // Why: no agentStatusEpoch / sortEpoch bump here (mirrors retainAgents).
      // Retained rows are a pure read-overlay on top of agentStatusByPaneKey —
      // they do not contribute to smart-sort scoring (see computeSmartScore*
      // in smart-sort.ts, which reads agentStatusByPaneKey only) and dashboard
      // selectors re-render on retainedAgentsByPaneKey identity changes
      // directly. Bumping epochs would force sidebar re-sorts and selector
      // recomputations for a change that cannot affect either result.
      set((s) => {
        if (!(paneKey in s.retainedAgentsByPaneKey)) {
          return s
        }
        const next = { ...s.retainedAgentsByPaneKey }
        delete next[paneKey]
        // Why: mirror dropAgentStatus's hasLive-gated suppressor. If the same
        // paneKey has BOTH a retained entry AND a concurrent live entry, simply
        // removing the retained row leaves the live entry free to vanish
        // cleanly on its next disappearance — and because
        // collectRetainedAgentsOnDisappear (useRetainedAgents.ts) only skips
        // paneKeys that are currently in retainedAgentsByPaneKey, the
        // just-dismissed row would be resurrected by a new retention snapshot.
        // Plant a one-shot suppressor so the next live→gone transition for
        // this paneKey is ignored by the retention sync.
        //
        // Gate on `paneKey in agentStatusByPaneKey`: with no live entry there
        // is no live→gone transition to guard against, and a stray suppressor
        // would leak indefinitely (same rationale as dropAgentStatus).
        const hasLive = paneKey in s.agentStatusByPaneKey
        if (!hasLive || paneKey in s.retentionSuppressedPaneKeys) {
          return { retainedAgentsByPaneKey: next }
        }
        return {
          retainedAgentsByPaneKey: next,
          retentionSuppressedPaneKeys: {
            ...s.retentionSuppressedPaneKeys,
            [paneKey]: true
          }
        }
      })
    },

    dismissRetainedAgentsByWorktree: (worktreeId) => {
      set((s) => {
        let changed = false
        const next: Record<string, RetainedAgentEntry> = {}
        // Why: mirror dismissRetainedAgent's hasLive-gated suppressor logic.
        // When a dismissed paneKey ALSO has a concurrent live entry in
        // agentStatusByPaneKey, removing the retained row alone lets the next
        // live→gone transition for that paneKey re-retain the row via the
        // retention sync (collectRetainedAgentsOnDisappear only skips paneKeys
        // currently present in retainedAgentsByPaneKey). Without planting a
        // suppressor here, "Dismiss all" for a worktree would silently
        // resurrect the just-dismissed rows as soon as the live agents
        // disappeared. Only plant suppressors for the hasLive subset — a stray
        // suppressor on a retained-only paneKey would leak indefinitely
        // because no live→gone transition would ever consume it.
        const toSuppress: string[] = []
        for (const [key, ra] of Object.entries(s.retainedAgentsByPaneKey)) {
          if (ra.worktreeId === worktreeId) {
            changed = true
            if (key in s.agentStatusByPaneKey && !(key in s.retentionSuppressedPaneKeys)) {
              toSuppress.push(key)
            }
            continue
          }
          next[key] = ra
        }
        if (!changed) {
          return s
        }
        if (toSuppress.length === 0) {
          return { retainedAgentsByPaneKey: next }
        }
        const nextSuppressed = { ...s.retentionSuppressedPaneKeys }
        for (const key of toSuppress) {
          nextSuppressed[key] = true
        }
        return {
          retainedAgentsByPaneKey: next,
          retentionSuppressedPaneKeys: nextSuppressed
        }
      })
    },

    pruneRetainedAgents: (validWorktreeIds) => {
      // Why: deliberately does NOT sweep retentionSuppressedPaneKeys for
      // pruned worktrees. PaneKeys are minted fresh when a worktree is
      // re-created (worktrees keep unique tab IDs), so stale suppressors
      // keyed on pruned paneKeys can never be matched by a future live entry
      // — they are inert and harmless. Sweeping them would add churn for no
      // observable benefit.
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
    },

    clearRetentionSuppressedPaneKeys: (paneKeys) => {
      set((s) => {
        let changed = false
        const next = { ...s.retentionSuppressedPaneKeys }
        for (const paneKey of paneKeys) {
          if (!(paneKey in next)) {
            continue
          }
          delete next[paneKey]
          changed = true
        }
        return changed ? { retentionSuppressedPaneKeys: next } : s
      })
    }
  }
}
