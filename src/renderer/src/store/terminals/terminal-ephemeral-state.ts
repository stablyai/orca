import { isClaudeAgent } from '@/lib/agent-status'
import { recordTerminalInputActivity } from '@/lib/terminal-input-activity-coalescing'
import { classifyTitleActivity } from '@/lib/pane-agent-evidence'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'

export function createTerminalEphemeralActions(
  set: TerminalStoreSet,
  get: TerminalStoreGet
): Pick<
  TerminalSlice,
  | 'markDefaultTerminalTabsApplied'
  | 'setHydrationSucceeded'
  | 'setRecentQuickCommandForGroup'
  | 'claimAutomaticAgentResume'
  | 'seedNativeChatLaunchPrompt'
  | 'markNativeChatLaunchPromptFailed'
  | 'clearNativeChatLaunchPrompt'
  | 'seedNativeChatLaunchDraft'
  | 'markNativeChatLaunchDraftAdopted'
  | 'resolveNativeChatLaunchDraft'
  | 'clearNativeChatLaunchDraft'
  | 'recordTerminalInput'
  | 'setCacheTimerStartedAt'
  | 'seedCacheTimersForIdleTabs'
  | 'setDeferredSshReconnectTargets'
  | 'removeDeferredSshReconnectTarget'
  | 'removeDeferredSshSessionId'
> {
  return {
    markDefaultTerminalTabsApplied: (worktreeId) =>
      set((s) => {
        if (s.defaultTerminalTabsAppliedByWorktreeId[worktreeId]) {
          return {}
        }
        return {
          defaultTerminalTabsAppliedByWorktreeId: {
            ...s.defaultTerminalTabsAppliedByWorktreeId,
            [worktreeId]: true
          }
        }
      }),
    setHydrationSucceeded: (value) => {
      set({ hydrationSucceeded: value })
    },
    setRecentQuickCommandForGroup: (groupId, quickCommandId) => {
      set((s) => ({
        recentQuickCommandIdByGroup: {
          ...s.recentQuickCommandIdByGroup,
          [groupId]: quickCommandId
        }
      }))
    },
    claimAutomaticAgentResume: (tabId, claim) => {
      set((s) => ({
        automaticAgentResumeClaimsByTabId: {
          ...s.automaticAgentResumeClaimsByTabId,
          [tabId]: claim
        }
      }))
    },
    seedNativeChatLaunchPrompt: (prompt) => {
      set((s) => ({
        nativeChatLaunchPromptByTabId: {
          ...s.nativeChatLaunchPromptByTabId,
          [prompt.tabId]: prompt
        }
      }))
    },
    markNativeChatLaunchPromptFailed: (tabId) => {
      set((s) => {
        const current = s.nativeChatLaunchPromptByTabId[tabId]
        if (!current || current.failed) {
          return {}
        }
        return {
          nativeChatLaunchPromptByTabId: {
            ...s.nativeChatLaunchPromptByTabId,
            [tabId]: { ...current, failed: true }
          }
        }
      })
    },
    clearNativeChatLaunchPrompt: (tabId) => {
      set((s) => {
        if (!s.nativeChatLaunchPromptByTabId[tabId]) {
          return {}
        }
        const next = { ...s.nativeChatLaunchPromptByTabId }
        delete next[tabId]
        return { nativeChatLaunchPromptByTabId: next }
      })
    },
    seedNativeChatLaunchDraft: (draft) => {
      set((s) => ({
        nativeChatLaunchDraftByTabId: {
          ...s.nativeChatLaunchDraftByTabId,
          [draft.tabId]: draft
        }
      }))
    },
    markNativeChatLaunchDraftAdopted: (tabId) => {
      set((s) => {
        const current = s.nativeChatLaunchDraftByTabId[tabId]
        if (!current || current.adopted) {
          return {}
        }
        return {
          nativeChatLaunchDraftByTabId: {
            ...s.nativeChatLaunchDraftByTabId,
            [tabId]: { ...current, adopted: true }
          }
        }
      })
    },
    resolveNativeChatLaunchDraft: (tabId, resolution) => {
      set((s) => {
        const current = s.nativeChatLaunchDraftByTabId[tabId]
        if (
          !current ||
          current.resolved ||
          current.createdAt !== resolution.createdAt ||
          current.text !== resolution.text
        ) {
          return {}
        }
        return {
          nativeChatLaunchDraftByTabId: {
            ...s.nativeChatLaunchDraftByTabId,
            [tabId]: { ...current, resolved: true }
          }
        }
      })
    },
    clearNativeChatLaunchDraft: (tabId) => {
      set((s) => {
        if (!s.nativeChatLaunchDraftByTabId[tabId]) {
          return {}
        }
        const next = { ...s.nativeChatLaunchDraftByTabId }
        delete next[tabId]
        return { nativeChatLaunchDraftByTabId: next }
      })
    },
    recordTerminalInput: (paneKey, timestamp = Date.now()) => {
      if (!paneKey || !Number.isFinite(timestamp)) {
        return
      }
      recordTerminalInputActivity({
        paneKey,
        timestamp,
        // Why: the first stamp for a pane must land synchronously; automation take-over
        // detection subscribes and compares undefined→value across a launch.
        forceWrite: get().lastTerminalInputAtByPaneKey[paneKey] === undefined,
        commit: {
          insert: (key, at) =>
            set((s) => ({
              lastTerminalInputAtByPaneKey: { ...s.lastTerminalInputAtByPaneKey, [key]: at }
            })),
          refreshExisting: (entries) =>
            set((s) => {
              let next: Record<string, number> | null = null
              for (const [key, at] of entries) {
                // Why: teardown (close pane/tab/worktree purge) deletes keys; a late flush must not resurrect them.
                const current = s.lastTerminalInputAtByPaneKey[key]
                if (current === undefined || current >= at) {
                  continue
                }
                next ??= { ...s.lastTerminalInputAtByPaneKey }
                next[key] = at
              }
              return next ? { lastTerminalInputAtByPaneKey: next } : {}
            })
        }
      })
    },
    setCacheTimerStartedAt: (key, ts) => {
      set((s) => {
        // Why: a real pane write clears any ':seed' sentinel from seedCacheTimersForIdleTabs, avoiding phantom timers when the seed key doesn't match the real pane.
        const colonIdx = key.indexOf(':')
        const suffix = colonIdx === -1 ? null : key.slice(colonIdx + 1)
        const seedKey =
          colonIdx !== -1 && suffix !== 'seed' ? `${key.slice(0, colonIdx)}:seed` : null
        const hasStaleSeed = seedKey !== null && seedKey in s.cacheTimerByKey
        // Why: parked-pane watchers replay null-over-null on every working/exit transition; each redundant write runs every subscriber's selector.
        if (s.cacheTimerByKey[key] === ts && !hasStaleSeed) {
          return s
        }
        const next = { ...s.cacheTimerByKey, [key]: ts }
        if (seedKey !== null) {
          delete next[seedKey]
        }
        return { cacheTimerByKey: next }
      })
    },
    seedCacheTimersForIdleTabs: () => {
      // Why: tabs already idle when the feature is enabled mid-session missed their working→idle transition, so seed timers for them.
      const s = get()
      const now = Date.now()
      const updates: Record<string, number> = {}
      for (const tabs of Object.values(s.tabsByWorktree)) {
        for (const tab of tabs) {
          if (!tab.title || !isClaudeAgent(tab.title)) {
            continue
          }
          const status = classifyTitleActivity(tab.title)
          if (status === null || status === 'working') {
            continue
          }
          // Why: the store doesn't know which pane holds the idle session, so use a ':seed' sentinel; setCacheTimerStartedAt clears it on any real pane write.
          const key = `${tab.id}:seed`
          if (s.cacheTimerByKey[key] == null) {
            updates[key] = now
          }
        }
      }
      if (Object.keys(updates).length > 0) {
        set((s) => ({
          cacheTimerByKey: { ...s.cacheTimerByKey, ...updates }
        }))
      }
    },
    setDeferredSshReconnectTargets: (targetIds) => set({ deferredSshReconnectTargets: targetIds }),
    removeDeferredSshReconnectTarget: (targetId) =>
      set((s) => ({
        deferredSshReconnectTargets: s.deferredSshReconnectTargets.filter((id) => id !== targetId)
      })),
    removeDeferredSshSessionId: (tabId) =>
      set((s) => {
        if (!s.deferredSshSessionIdsByTabId[tabId]) {
          return {}
        }
        const next = { ...s.deferredSshSessionIdsByTabId }
        delete next[tabId]
        return { deferredSshSessionIdsByTabId: next }
      })
  }
}
