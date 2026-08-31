import { isDecorativeAgentTitleFrameChange } from '../../../../shared/agent-decorative-title-signature'
import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'
import { classifyTitleActivity } from '@/lib/pane-agent-evidence'
import {
  applyGeneratedTabTitleUpdates,
  applyTerminalTabTitleUpdates
} from '../slices/terminal-tab-title-batch'
import {
  adoptTerminalTabOwnerMetadataOnlyBuckets,
  getTerminalTabOwnerWorktreeId
} from '../slices/terminal-tab-owner-index'
import { getTabIdFromPaneKey } from './terminal-pty-identities'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'

export function createTerminalTabPresentationActions(
  set: TerminalStoreSet,
  get: TerminalStoreGet
): Pick<
  TerminalSlice,
  | 'updateTabTitle'
  | 'updateTabTitles'
  | 'setAiVaultTabTitle'
  | 'setGeneratedTabTitleFromAgentPrompt'
  | 'setGeneratedTabTitlesFromAgentPrompts'
  | 'clearTabLaunchAgent'
  | 'setRuntimePaneTitle'
  | 'clearRuntimePaneTitle'
> {
  return {
    updateTabTitle: (tabId, title) => {
      set((state) => {
        const result = applyTerminalTabTitleUpdates(state, [{ tabId, title }])
        if (result.runtimeGraphChanged) {
          scheduleRuntimeGraphSync()
        }
        return result.patch ?? state
      })
    },
    updateTabTitles: (updates) => {
      if (updates.length === 0) {
        return
      }
      set((state) => {
        const result = applyTerminalTabTitleUpdates(state, updates)
        if (result.runtimeGraphChanged) {
          scheduleRuntimeGraphSync()
        }
        return result.patch ?? state
      })
    },
    setAiVaultTabTitle: (tabId, aiVaultTitle) => {
      set((s) => {
        const ownerWorktreeId = getTerminalTabOwnerWorktreeId(s.tabsByWorktree, tabId)
        if (!ownerWorktreeId) {
          return s
        }
        const tabs = s.tabsByWorktree[ownerWorktreeId] ?? []
        const current = tabs.find((tab) => tab.id === tabId)
        const sameTitle =
          current?.aiVaultTitle?.agent === aiVaultTitle?.agent &&
          current?.aiVaultTitle?.sessionId === aiVaultTitle?.sessionId &&
          current?.aiVaultTitle?.title === aiVaultTitle?.title
        if (!current || sameTitle) {
          return s
        }
        const ownerTabs = tabs.map((tab) => (tab.id === tabId ? { ...tab, aiVaultTitle } : tab))
        const nextTabsByWorktree = { ...s.tabsByWorktree, [ownerWorktreeId]: ownerTabs }
        const unifiedTabs = s.unifiedTabsByWorktree[ownerWorktreeId] ?? []
        const nextUnifiedTabs = unifiedTabs.map((tab) =>
          tab.contentType === 'terminal' && tab.entityId === tabId ? { ...tab, aiVaultTitle } : tab
        )
        adoptTerminalTabOwnerMetadataOnlyBuckets(s.tabsByWorktree, nextTabsByWorktree, [
          ownerWorktreeId
        ])
        scheduleRuntimeGraphSync()
        return {
          tabsByWorktree: nextTabsByWorktree,
          unifiedTabsByWorktree: {
            ...s.unifiedTabsByWorktree,
            [ownerWorktreeId]: nextUnifiedTabs
          }
        }
      })
    },
    setGeneratedTabTitleFromAgentPrompt: (paneKey, prompt, options) => {
      // Why: setAgentStatus is high-frequency; skip derive/set unless the feature is on and this tab still needs a (re)generated title.
      const state = get()
      const tabId = getTabIdFromPaneKey(paneKey)
      if (!tabId || prompt.length === 0 || state.settings?.tabAutoGenerateTitle !== true) {
        return
      }
      const ownerWorktreeId = getTerminalTabOwnerWorktreeId(state.tabsByWorktree, tabId)
      if (!ownerWorktreeId) {
        return
      }
      const tabs = state.tabsByWorktree[ownerWorktreeId] ?? []
      const currentTab = tabs.find((tab) => tab.id === tabId)
      if (!currentTab || currentTab.customTitle?.trim() || currentTab.quickCommandLabel?.trim()) {
        return
      }
      const existingGeneratedTitle = currentTab.generatedTitle?.trim()
      if (existingGeneratedTitle && options?.replaceExistingGeneratedTitle !== true) {
        return
      }
      set((latestState) => {
        const result = applyGeneratedTabTitleUpdates(latestState, [{ paneKey, prompt, options }])
        if (result.runtimeGraphChanged) {
          scheduleRuntimeGraphSync()
        }
        return result.patch ?? latestState
      })
    },
    setGeneratedTabTitlesFromAgentPrompts: (updates) => {
      if (updates.length === 0) {
        return
      }
      set((state) => {
        const result = applyGeneratedTabTitleUpdates(state, updates)
        if (result.runtimeGraphChanged) {
          scheduleRuntimeGraphSync()
        }
        return result.patch ?? state
      })
    },
    clearTabLaunchAgent: (tabId) => {
      set((s) => {
        const ownerWorktreeId = getTerminalTabOwnerWorktreeId(s.tabsByWorktree, tabId)
        if (!ownerWorktreeId) {
          return s
        }
        const tabs = s.tabsByWorktree[ownerWorktreeId] ?? []
        const tabIndex = tabs.findIndex((t) => t.id === tabId)
        const currentTab = tabs[tabIndex]
        if (!currentTab?.launchAgent) {
          return s
        }
        const { launchAgent: _launchAgent, ...tabWithoutLaunchAgent } = currentTab
        void _launchAgent
        const nextTabs = [...tabs]
        nextTabs[tabIndex] = tabWithoutLaunchAgent
        scheduleRuntimeGraphSync()
        return { tabsByWorktree: { ...s.tabsByWorktree, [ownerWorktreeId]: nextTabs } }
      })
    },
    setRuntimePaneTitle: (tabId, paneId, title) => {
      set((s) => {
        const currentByPane = s.runtimePaneTitlesByTabId[tabId] ?? {}
        const prevTitle = currentByPane[paneId]
        if (prevTitle === title) {
          return s
        }
        if (prevTitle && isDecorativeAgentTitleFrameChange(prevTitle, title)) {
          return s
        }
        // Why: re-sort hookless title changes only when their activity classification changes.
        const classificationChanged =
          classifyTitleActivity(prevTitle ?? '') !== classifyTitleActivity(title)
        // Why: skip active-worktree remount side effects and orphaned panes.
        const ownerWorktreeId = classificationChanged
          ? getTerminalTabOwnerWorktreeId(s.tabsByWorktree, tabId)
          : null
        const isActive = ownerWorktreeId !== null && ownerWorktreeId === s.activeWorktreeId
        const shouldBump = classificationChanged && ownerWorktreeId !== null && !isActive
        return {
          runtimePaneTitlesByTabId: {
            ...s.runtimePaneTitlesByTabId,
            [tabId]: { ...currentByPane, [paneId]: title }
          },
          ...(shouldBump ? { sortEpoch: s.sortEpoch + 1 } : {})
        }
      })
    },
    clearRuntimePaneTitle: (tabId, paneId) => {
      set((s) => {
        const currentByPane = s.runtimePaneTitlesByTabId[tabId]
        if (!currentByPane || !(paneId in currentByPane)) {
          return s
        }
        const prevTitle = currentByPane[paneId]
        const nextByPane = { ...currentByPane }
        delete nextByPane[paneId]
        const next = { ...s.runtimePaneTitlesByTabId }
        if (Object.keys(nextByPane).length > 0) {
          next[tabId] = nextByPane
        } else {
          delete next[tabId]
        }
        // Why: clearing a classified title changes the smart-sort title-heuristic verdict, so it needs a re-sort. See setRuntimePaneTitle.
        const hadClassification = classifyTitleActivity(prevTitle ?? '') !== null
        // Why: same active-worktree gate as setRuntimePaneTitle — click-driven teardown clears must not re-rank the sidebar; skip when owner is missing (orphaned).
        const ownerWorktreeId = hadClassification
          ? getTerminalTabOwnerWorktreeId(s.tabsByWorktree, tabId)
          : null
        const isActive = ownerWorktreeId !== null && ownerWorktreeId === s.activeWorktreeId
        const shouldBump = hadClassification && ownerWorktreeId !== null && !isActive
        return {
          runtimePaneTitlesByTabId: next,
          ...(shouldBump ? { sortEpoch: s.sortEpoch + 1 } : {})
        }
      })
    }
  }
}
