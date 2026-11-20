// Local Home pins reconcile after restore; paired hosts keep the existing Home placement behavior.
import { useEffect } from 'react'
import type { StoreApi } from 'zustand'
import type { AppState } from '@/store/types'
import { useAppStore } from '@/store'
import { readBots, readBotsEnabled, subscribeToBotChanges } from '@/lib/bot-catalog'
import type { Bot } from '../../../../shared/bot-types'
import {
  isBotHomeTab,
  isBotSideChatTab,
  selectLocalBotHomeTabs
} from '../../../../shared/bots/bot-home-tab'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { collectTabGroupLayoutGroupIds } from '../../../../shared/workspace-layout/tab-groups/tab-group-moves'

type TabPlacementState = Pick<
  AppState,
  'unifiedTabsByWorktree' | 'groupsByWorktree' | 'layoutByWorktree'
>

export type BotHomeTabMove =
  | { kind: 'group'; tabId: string; groupId: string }
  | { kind: 'order'; groupId: string; tabOrder: string[] }

/** What puts Home first in the top-left group holding tabs; null when it is there or not open. */
export function botHomeTabMove(
  state: TabPlacementState,
  worktreeId: string,
  bot: Pick<Bot, 'chatSessionId' | 'hostId' | 'folderWorkspaceId'>
): BotHomeTabMove | null {
  const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  const home =
    bot.hostId === LOCAL_EXECUTION_HOST_ID
      ? selectLocalBotHomeTabs(tabs, bot)?.home
      : tabs.find((tab) => isBotHomeTab(tab, bot))
  const groups = state.groupsByWorktree[worktreeId] ?? []
  if (!home) {
    return null
  }
  const byId = new Map(groups.map((group) => [group.id, group]))
  const inLayoutOrder = [...collectTabGroupLayoutGroupIds(state.layoutByWorktree[worktreeId])]
    .flatMap((id) => byId.get(id) ?? [])
    .concat(groups)
  // An empty split is still choosing what to show; Home joins it only once it holds a tab.
  const target = inLayoutOrder.find((group) => group.tabOrder.length > 0)
  if (!target) {
    return null
  }
  if (!target.tabOrder.includes(home.id)) {
    return { kind: 'group', tabId: home.id, groupId: target.id }
  }
  return target.tabOrder[0] === home.id
    ? null
    : {
        kind: 'order',
        groupId: target.id,
        tabOrder: [home.id, ...target.tabOrder.filter((id) => id !== home.id)]
      }
}

function placeBotHomeTabsOnce(store: StoreApi<AppState>): void {
  for (const bot of readBots()) {
    const worktreeId = folderWorkspaceKey(bot.folderWorkspaceId)
    if (!bot.chatSessionId) {
      continue
    }
    // A focused duplicate hands focus to Home only after Home's final move, which keeps the destination's selection.
    let focusHomeId: string | null = null
    if (bot.hostId === LOCAL_EXECUTION_HOST_ID) {
      const state = store.getState()
      if (!state.workspaceSessionReady) {
        continue
      }
      const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
      const selection = selectLocalBotHomeTabs(tabs, bot)
      if (!selection) {
        continue
      }
      const { home, duplicates } = selection
      for (const duplicate of duplicates) {
        const focusedDuplicate =
          state.activeGroupIdByWorktree[worktreeId] === duplicate.groupId &&
          state.groupsByWorktree[worktreeId]?.some(
            (group) => group.id === duplicate.groupId && group.activeTabId === duplicate.id
          )
        if (focusedDuplicate) {
          focusHomeId = home.id
        }
        store.getState().closeUnifiedTab(duplicate.id, {
          preserveAgentSession: true,
          preserveWorktreeSelection: true,
          recordInteraction: false
        })
      }
      for (const tab of tabs) {
        if (tab.isPinned && isBotSideChatTab(tab, bot)) {
          store.getState().unpinTab(tab.id, { recordInteraction: false })
        }
      }
      if (!home.isPinned) {
        store.getState().pinTab(home.id, { recordInteraction: false })
      }
    }
    const move = botHomeTabMove(store.getState(), worktreeId, bot)
    if (move?.kind === 'group') {
      store
        .getState()
        .moveUnifiedTabToGroup(move.tabId, move.groupId, { index: 0, recordInteraction: false })
    } else if (move) {
      store.getState().reorderUnifiedTabs(move.groupId, move.tabOrder, { recordInteraction: false })
    }
    if (focusHomeId) {
      store.getState().activateTab(focusHomeId, { worktreeId, recordFocus: false })
    }
  }
}

function createBotHomeTabPlacer(store: StoreApi<AppState>): () => void {
  let running = false
  return () => {
    if (running || !readBotsEnabled()) {
      return
    }
    running = true
    try {
      placeBotHomeTabsOnce(store)
    } finally {
      running = false
    }
  }
}

/** Puts Home back after any change to tabs, groups or splits, whatever made it: drags, closes, restores, opens. */
export function installBotHomeTabPlacement(store: StoreApi<AppState> = useAppStore): () => void {
  const place = createBotHomeTabPlacer(store)
  const stopStore = store.subscribe((state, previous) => {
    if (
      state.unifiedTabsByWorktree !== previous.unifiedTabsByWorktree ||
      state.groupsByWorktree !== previous.groupsByWorktree ||
      state.layoutByWorktree !== previous.layoutByWorktree ||
      state.workspaceSessionReady !== previous.workspaceSessionReady
    ) {
      place()
    }
  })
  const stopBots = subscribeToBotChanges(place)
  place()
  return () => {
    stopStore()
    stopBots()
  }
}

export function useBotHomeTabPlacement(): void {
  useEffect(() => installBotHomeTabPlacement(), [])
}
