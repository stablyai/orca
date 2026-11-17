// A bot's Home tab is always the first tab of its page's top-left group, in every window; only Home may be pinned there.
import { useEffect } from 'react'
import type { StoreApi } from 'zustand'
import type { AppState } from '@/store/types'
import { useAppStore } from '@/store'
import { readBots, readBotsEnabled, subscribeToBotChanges } from '@/lib/bot-catalog'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/workspace/ownership/worktree-runtime-owner'
import type { Bot } from '../../../../shared/bot-types'
import { isBotHomeTab, isBotSideChatTab } from '../../../../shared/bots/bot-home-tab'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { collectTabGroupLayoutGroupIds } from '../../../../shared/workspace-layout/tab-groups/tab-group-moves'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'

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
  bot: Pick<Bot, 'chatSessionId'>
): BotHomeTabMove | null {
  const home = state.unifiedTabsByWorktree[worktreeId]?.find((tab) => isBotHomeTab(tab, bot))
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

/** Side chats pinned before pins were Home's alone; this window may only unpin pages whose layout it owns. */
function pinnedSideChatIds(state: AppState, worktreeId: string, bot: Bot): string[] {
  if (!state.workspaceSessionReady || bot.hostId !== LOCAL_EXECUTION_HOST_ID) {
    return []
  }
  const pinned = (state.unifiedTabsByWorktree[worktreeId] ?? []).filter(
    (tab) => tab.isPinned && isBotSideChatTab(tab, bot)
  )
  // A paired host's page takes its pins from that host, which unpins them itself; main-owned layouts are not wired.
  return pinned.length === 0 ||
    ORCA_LAYOUT_OWNER_IS_MAIN ||
    runtimeEnvironmentIdOrLocalUnlessTwin(state, worktreeId) !== null
    ? []
    : pinned.map((tab) => tab.id)
}

function placeBotHomeTabsOnce(store: StoreApi<AppState>): void {
  for (const bot of readBots()) {
    const worktreeId = folderWorkspaceKey(bot.folderWorkspaceId)
    for (const tabId of pinnedSideChatIds(store.getState(), worktreeId, bot)) {
      store.getState().unpinTab(tabId, { recordInteraction: false })
    }
    if (!bot.chatSessionId) {
      continue
    }
    const move = botHomeTabMove(store.getState(), worktreeId, bot)
    if (move?.kind === 'group') {
      store
        .getState()
        .moveUnifiedTabToGroup(move.tabId, move.groupId, { index: 0, recordInteraction: false })
    } else if (move) {
      store.getState().reorderUnifiedTabs(move.groupId, move.tabOrder, { recordInteraction: false })
    }
  }
}

// Its own writes notify the store's subscribers synchronously, so a pass started inside one only marks another.
const MAX_PLACEMENT_PASSES = 3

function createBotHomeTabPlacer(store: StoreApi<AppState>): () => void {
  let running = false
  let dirty = false
  return () => {
    if (running) {
      dirty = true
      return
    }
    if (!readBotsEnabled()) {
      return
    }
    running = true
    try {
      for (let pass = 0; pass < MAX_PLACEMENT_PASSES; pass++) {
        dirty = false
        placeBotHomeTabsOnce(store)
        if (!dirty) {
          return
        }
      }
      console.warn('[bots] Home tab placement did not settle')
    } finally {
      running = false
      dirty = false
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
