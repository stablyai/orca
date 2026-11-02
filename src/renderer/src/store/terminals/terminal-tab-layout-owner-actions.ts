import type { AppState } from '../types'
import {
  applyGeneratedTabTitleUpdates,
  getTabIdFromPaneKey,
  type GeneratedTabTitleUpdate
} from '../slices/terminal-tab-title-batch'
import { getTerminalTabOwnerWorktreeId } from '../slices/terminal-tab-owner-index'
import type { TerminalSlice, TerminalStoreGet } from './terminal-state'
import {
  sendRenamableTabChangeToLayoutOwner,
  type TabChange
} from './tab-change-through-layout-owner'

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

/** Each tab's generated title the window would give it now, with the updates that give it. */
function generatedTitleChanges(state: AppState, updates: readonly GeneratedTabTitleUpdate[]) {
  const patched = applyGeneratedTabTitleUpdates(state, updates).patch?.tabsByWorktree ?? {}
  return Object.values(patched)
    .flat()
    .flatMap((tab) => {
      const title = tab.generatedTitle ?? null
      return title === (terminalTab(state, tab.id)?.generatedTitle ?? null)
        ? []
        : [
            {
              tabId: tab.id,
              title,
              updates: updates.filter((u) => getTabIdFromPaneKey(u.paneKey) === tab.id)
            }
          ]
    })
}

/**
 * A layout-owner build's terminal tab changes from any caller (CLI rename, templates, agent
 * titles, an ended launch agent): main changes its copy first, then the window's own action shows
 * the same change. Before this, only the tab bar's rename and color reached main; the rest reached
 * it only through the window's session save.
 */
export function routeTerminalTabChangesThroughLayoutOwner(
  actions: RoutedActions,
  get: TerminalStoreGet
): RoutedActions {
  const route = (tabId: string, change: TabChange, local: () => void): void => {
    sendRenamableTabChangeToLayoutOwner(get(), tabId, change, local)
  }
  /** Tabs whose generated title main has and the window does not yet: the window keeps a first title. */
  const generatedTitleSent = new Map<string, object>()
  const routeGeneratedTitles = (updates: readonly GeneratedTabTitleUpdate[]): void => {
    const unsent = updates.filter(
      (update) =>
        update.options?.replaceExistingGeneratedTitle === true ||
        !generatedTitleSent.has(getTabIdFromPaneKey(update.paneKey) ?? '')
    )
    for (const { tabId, title, updates: ofTab } of generatedTitleChanges(get(), unsent)) {
      const entry = {}
      const settle = (): void => {
        if (generatedTitleSent.get(tabId) === entry) {
          generatedTitleSent.delete(tabId)
        }
      }
      const sent = sendRenamableTabChangeToLayoutOwner(
        get(),
        tabId,
        (id) => ({ type: 'renameTab', tabId: id, kind: 'generated', title }),
        () => {
          settle()
          actions.setGeneratedTabTitlesFromAgentPrompts(ofTab)
        },
        settle
      )
      if (sent) {
        generatedTitleSent.set(tabId, entry)
      }
    }
  }
  return {
    setTabCustomTitle: (tabId, title, opts) =>
      route(
        tabId,
        (id) => ({ type: 'renameTab', tabId: id, kind: 'custom', title }),
        () => actions.setTabCustomTitle(tabId, title, opts)
      ),
    setTabColor: (tabId, color) =>
      route(
        tabId,
        (id) => ({ type: 'setTabProps', tabId: id, color }),
        () => actions.setTabColor(tabId, color)
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
