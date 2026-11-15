import { recordTerminalInputActivity } from '@/lib/terminal/input/terminal-input-activity-coalescing'
import { promptCacheRestStartedAt } from '@/lib/agent-status/evidence/prompt-cache-request-evidence'
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
          return s
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
          return s
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
          return s
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
          return s
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
          return s
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
          return s
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
        // Publish first pane input synchronously so automation takeover observes undefined→timestamp across launch.
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
              return next ? { lastTerminalInputAtByPaneKey: next } : s
            })
        }
      })
    },
    setCacheTimerStartedAt: (key, entry) => {
      set((s) => {
        // Why: parked-pane watchers replay the same write on every working/exit transition; each redundant write runs every subscriber's selector.
        if (s.cacheTimerByKey[key] === (entry ?? undefined)) {
          return s
        }
        if (entry === null) {
          // Why: deleting forgets the ended session's request evidence so the next agent starts without it.
          const { [key]: _ended, ...rest } = s.cacheTimerByKey
          return { cacheTimerByKey: rest }
        }
        return { cacheTimerByKey: { ...s.cacheTimerByKey, [key]: entry } }
      })
    },
    seedCacheTimersForIdleTabs: () => {
      const s = get()
      const now = Date.now()
      const updates: Record<string, number> = {}
      for (const [key, timer] of Object.entries(s.cacheTimerByKey)) {
        // Why: only panes that sent a request while the setting was off hold an untimed cache.
        const restStartedAt =
          timer === 'requested' ? promptCacheRestStartedAt(s.agentStatusByPaneKey[key], now) : null
        if (restStartedAt !== null) {
          updates[key] = restStartedAt
        }
      }
      if (Object.keys(updates).length > 0) {
        set((state) => ({
          cacheTimerByKey: { ...state.cacheTimerByKey, ...updates }
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
          return s
        }
        const next = { ...s.deferredSshSessionIdsByTabId }
        delete next[tabId]
        return { deferredSshSessionIdsByTabId: next }
      })
  }
}
