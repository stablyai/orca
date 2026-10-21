import type { Tab } from '../../../../shared/tab-types'
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
import { findRenamableUnifiedTab } from './renamable-unified-tab'
import { sendGeneratedTabTitles } from '@/runtime/generated-tab-titles-send'

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

type GeneratedTitleChange = {
  tabId: string
  title: string | null
  updates: GeneratedTabTitleUpdate[]
}

/** Each tab's generated title the window would give it now, with the updates that give it. */
function generatedTitleChanges(
  state: AppState,
  updates: readonly GeneratedTabTitleUpdate[]
): GeneratedTitleChange[] {
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
  /** Tabs whose generated title main has and the window does not yet: the window keeps a first title. */
  const generatedTitleSent = new Map<string, object>()
  // Why one send: a status batch's titles are one write and one frame in main, and one store update.
  const routeGeneratedTitles = (updates: readonly GeneratedTabTitleUpdate[]): void => {
    const unsent = updates.filter(
      (update) =>
        update.options?.replaceExistingGeneratedTitle === true ||
        !generatedTitleSent.has(getTabIdFromPaneKey(update.paneKey) ?? '')
    )
    const state = get()
    const toMain: (GeneratedTitleChange & { tab: Tab })[] = []
    // Main is not asked for a tab it has no tab-bar entry for, nor one a paired server owns.
    const local: GeneratedTabTitleUpdate[] = []
    for (const change of generatedTitleChanges(state, unsent)) {
      const tab = findRenamableUnifiedTab(state.unifiedTabsByWorktree, change.tabId)
      if (tab) {
        toMain.push({ ...change, tab })
      } else {
        local.push(...change.updates)
      }
    }
    const entry = {}
    const sent = sendGeneratedTabTitles(
      state,
      toMain.map(({ tab, title, updates: given }) => ({
        worktreeId: tab.worktreeId,
        tabId: tab.id,
        title,
        // Main keeps a tab's first generated title, as the window does, unless the update replaces it.
        ...(given.some((update) => update.options?.replaceExistingGeneratedTitle === true)
          ? { replaceExisting: true as const }
          : {})
      })),
      (outcomes) => {
        for (const { tabId } of toMain) {
          if (generatedTitleSent.get(tabId) === entry) {
            generatedTitleSent.delete(tabId)
          }
        }
        // Main's frame drew the titles it gave; the window shows only those left to it as today.
        const asToday = toMain.flatMap((change, index) =>
          outcomes[index] === 'asToday' ? change.updates : []
        )
        if (asToday.length > 0) {
          actions.setGeneratedTabTitlesFromAgentPrompts(asToday)
        }
      }
    )
    toMain.forEach((change, index) => {
      if (sent[index]) {
        generatedTitleSent.set(change.tabId, entry)
      } else {
        local.push(...change.updates)
      }
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
