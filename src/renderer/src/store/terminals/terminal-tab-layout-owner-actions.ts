import type { AppState } from '../types'
import {
  getTabIdFromPaneKey,
  type GeneratedTabTitleUpdate
} from '../slices/terminal-tab-title-batch'
import { getTerminalTabOwnerWorktreeId } from '../slices/terminal-tab-owner-index'
import type { TerminalSlice, TerminalStoreGet } from './terminal-state'
import {
  sendRenamableTabChangeToLayoutOwner,
  type TabChange
} from './tab-change-through-layout-owner'
import { findRenamableUnifiedTab } from './renamable-unified-tab'
import { runtimeEnvironmentIdForWorkspaceOwner } from '@/lib/resolve-owner'

type RoutedActions = Pick<
  TerminalSlice,
  | 'setTabCustomTitle'
  | 'setTabColor'
  | 'setAiVaultTabTitle'
  | 'setGeneratedTabTitleFromAgentPrompt'
  | 'setGeneratedTabTitlesFromAgentPrompts'
  | 'clearTabLaunchAgent'
>

function terminalTab(state: AppState, tabId: string) {
  const owner = getTerminalTabOwnerWorktreeId(state.tabsByWorktree, tabId)
  return owner ? state.tabsByWorktree[owner]?.find((tab) => tab.id === tabId) : undefined
}

/**
 * A layout-owner build's terminal tab changes from any caller (CLI rename, templates, agent
 * titles, an ended launch agent): main changes its copy and its frame draws the change. The
 * window's own action runs only for a tab main is not asked about or a paired server holds.
 */
export function routeTerminalTabChangesThroughLayoutOwner(
  actions: RoutedActions,
  get: TerminalStoreGet
): RoutedActions {
  const route = (tabId: string, change: TabChange, local: () => void, shown?: () => void): void => {
    sendRenamableTabChangeToLayoutOwner(get(), tabId, change, local, { shown })
  }
  // The tab bar's own rename and color count as a use of terminal tabs, as the window's action does.
  const recordTabsInteraction = (): void => {
    void get().recordFeatureInteraction?.('terminal-tabs')
  }
  // Why: main derives the generated titles of the tabs it holds from the agent status it owns, so
  // the window titles only a tab main has no tab-bar entry for or a paired server holds.
  const routeGeneratedTitles = (updates: readonly GeneratedTabTitleUpdate[]): void => {
    const state = get()
    const local = updates.filter((update) => {
      const tab = findRenamableUnifiedTab(
        state.unifiedTabsByWorktree,
        getTabIdFromPaneKey(update.paneKey) ?? ''
      )
      if (!tab) {
        return true
      }
      // A twin (an owner the window cannot resolve) main refuses, so the window titles it as before.
      const owner = runtimeEnvironmentIdForWorkspaceOwner(state, { workspaceId: tab.worktreeId })
      return owner.kind !== 'resolved' || owner.environmentId !== null
    })
    if (local.length > 0) {
      actions.setGeneratedTabTitlesFromAgentPrompts(local)
    }
  }
  return {
    setTabCustomTitle: (tabId, title, opts) =>
      route(
        tabId,
        (id) => ({ type: 'renameTab', tabId: id, kind: 'custom', title }),
        () => actions.setTabCustomTitle(tabId, title, opts),
        opts?.recordInteraction === false ? undefined : recordTabsInteraction
      ),
    setTabColor: (tabId, color, opts) =>
      route(
        tabId,
        (id) => ({ type: 'setTabProps', tabId: id, color }),
        () => actions.setTabColor(tabId, color, opts),
        opts?.recordInteraction === false ? undefined : recordTabsInteraction
      ),
    setAiVaultTabTitle: (tabId, title) => {
      const current = terminalTab(get(), tabId)?.aiVaultTitle ?? null
      if (JSON.stringify(current) === JSON.stringify(title ?? null)) {
        actions.setAiVaultTabTitle(tabId, title)
        return
      }
      route(
        tabId,
        (id) => ({ type: 'renameTab', tabId: id, kind: 'aiVault', title }),
        () => actions.setAiVaultTabTitle(tabId, title)
      )
    },
    setGeneratedTabTitleFromAgentPrompt: (paneKey, prompt, options) => {
      // Why: called on every agent status; only a tab that would get a title is worth a dry run.
      if (get().settings?.tabAutoGenerateTitle === true && prompt.length > 0) {
        routeGeneratedTitles([{ paneKey, prompt, options }])
      }
    },
    setGeneratedTabTitlesFromAgentPrompts: routeGeneratedTitles,
    clearTabLaunchAgent: (tabId) => {
      if (!terminalTab(get(), tabId)?.launchAgent) {
        actions.clearTabLaunchAgent(tabId)
        return
      }
      route(
        tabId,
        (id) => ({ type: 'setTabProps', tabId: id, clearLaunchAgent: true }),
        () => actions.clearTabLaunchAgent(tabId)
      )
    }
  }
}
