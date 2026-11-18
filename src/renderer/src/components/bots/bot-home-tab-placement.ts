// A bot's Home tab is always the first tab of its page's top-left group, in every window.
import { useEffect } from 'react'
import type { StoreApi } from 'zustand'
import type { AppState } from '@/store/types'
import { useAppStore } from '@/store'
import { readBots, readBotsEnabled, subscribeToBotChanges } from '@/lib/bot-catalog'
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
  homeSessionId: string
): BotHomeTabMove | null {
  const home = state.unifiedTabsByWorktree[worktreeId]?.find(
    (tab) => tab.contentType === 'agent-session' && tab.entityId === homeSessionId
  )
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

function placeBotHomeTabs(store: StoreApi<AppState>): void {
  if (!readBotsEnabled()) {
    return
  }
  for (const bot of readBots()) {
    if (!bot.chatSessionId) {
      continue
    }
    const move = botHomeTabMove(
      store.getState(),
      folderWorkspaceKey(bot.folderWorkspaceId),
      bot.chatSessionId
    )
    if (move?.kind === 'group') {
      store
        .getState()
        .moveUnifiedTabToGroup(move.tabId, move.groupId, { index: 0, recordInteraction: false })
    } else if (move) {
      store.getState().reorderUnifiedTabs(move.groupId, move.tabOrder, { recordInteraction: false })
    }
  }
}

/** Puts Home back after any change to tabs, groups or splits, whatever made it: drags, closes, restores, opens. */
export function installBotHomeTabPlacement(store: StoreApi<AppState> = useAppStore): () => void {
  const place = (): void => placeBotHomeTabs(store)
  const stopStore = store.subscribe((state, previous) => {
    if (
      state.unifiedTabsByWorktree !== previous.unifiedTabsByWorktree ||
      state.groupsByWorktree !== previous.groupsByWorktree ||
      state.layoutByWorktree !== previous.layoutByWorktree
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
