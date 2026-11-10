import {
  CLOSE_TERMINAL_PANE_EVENT,
  SET_TERMINAL_PANE_TITLE_EVENT,
  type CloseTerminalPaneDetail,
  type SetTerminalPaneTitleDetail
} from '@/constants/terminal'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { makePaneKey, parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { collectLeafIds } from '../../../../../shared/workspace-layout/terminal-pane-layout-tree'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { isSideChatProviderSession } from '../../../../../shared/agent-launch/side-chat/side-chat'

export type SideChat = {
  tabId: string
  parentLeafId: string
  sideLeafId: string
}

type TrackedSideChat = SideChat & { mounted: boolean; title: string | null }

// Why in memory only: side chats are ephemeral, so a restart must not bring the pairing back.
const sideChatsBySideKey = new Map<string, TrackedSideChat>()
let lastStatuses: AppState['agentStatusByPaneKey'] | null = null
let lastLayouts: AppState['terminalLayoutsByTabId'] | null = null

/** App-lifetime watcher: keeps side titles current, closes side chats with their parent, and sweeps restored ones. */
export function installSideChatTracking(store = useAppStore): () => void {
  const unsubscribe = store.subscribe(syncSideChats)
  syncSideChats(store.getState())
  return () => {
    unsubscribe()
    lastStatuses = null
    lastLayouts = null
  }
}

export function registerSideChat(sideChat: SideChat): void {
  sideChatsBySideKey.set(makePaneKey(sideChat.tabId, sideChat.sideLeafId), {
    ...sideChat,
    mounted: false,
    title: null
  })
}

export function unregisterSideChat(sideChat: SideChat): void {
  sideChatsBySideKey.delete(makePaneKey(sideChat.tabId, sideChat.sideLeafId))
}

export function findSideChatForParent(tabId: string, parentLeafId: string): SideChat | null {
  for (const sideChat of sideChatsBySideKey.values()) {
    if (sideChat.tabId === tabId && sideChat.parentLeafId === parentLeafId) {
      return sideChat
    }
  }
  return null
}

export function findSideChatBySide(tabId: string, sideLeafId: string): SideChat | null {
  return sideChatsBySideKey.get(makePaneKey(tabId, sideLeafId)) ?? null
}

export function sideChatTitle(parent: AgentStatusEntry | undefined): string {
  const base = translate('components.sideChat.title', 'Side chat · from main')
  const status = parentStatusLabel(parent)
  return status ? `${base} · ${status}` : base
}

function parentStatusLabel(parent: AgentStatusEntry | undefined): string | null {
  switch (parent?.state) {
    case 'working':
      return translate('components.sideChat.mainWorking', 'main working')
    case 'blocked':
      return translate('components.sideChat.mainNeedsApproval', 'main needs approval')
    case 'waiting':
      return translate('components.sideChat.mainNeedsInput', 'main needs input')
    case 'done':
      return parent.interrupted
        ? translate('components.sideChat.mainInterrupted', 'main interrupted')
        : translate('components.sideChat.mainFinished', 'main finished')
    case undefined:
      return null
  }
}

function layoutHasLeaf(state: AppState, tabId: string, leafId: string): boolean {
  return collectLeafIds(state.terminalLayoutsByTabId[tabId]?.root).includes(leafId)
}

const pendingCloses = new Set<string>()

function closePane(
  tabId: string,
  leafId: string,
  lastPaneCloseReason: CloseTerminalPaneDetail['lastPaneCloseReason']
): void {
  const key = makePaneKey(tabId, leafId)
  if (pendingCloses.has(key)) {
    return
  }
  pendingCloses.add(key)
  // Why deferred: closing re-enters the store, which is mid-notification here.
  setTimeout(() => {
    pendingCloses.delete(key)
    const detail: CloseTerminalPaneDetail = { tabId, leafId, lastPaneCloseReason }
    window.dispatchEvent(new CustomEvent(CLOSE_TERMINAL_PANE_EVENT, { detail }))
  }, 0)
}

function syncSideChats(state: AppState): void {
  if (state.agentStatusByPaneKey === lastStatuses && state.terminalLayoutsByTabId === lastLayouts) {
    return
  }
  lastStatuses = state.agentStatusByPaneKey
  lastLayouts = state.terminalLayoutsByTabId
  syncTrackedSideChats(state)
  closeOrphanedSideChats(state)
}

function syncTrackedSideChats(state: AppState): void {
  for (const [sideKey, sideChat] of sideChatsBySideKey) {
    if (!layoutHasLeaf(state, sideChat.tabId, sideChat.sideLeafId)) {
      // The split lands after registration; only a side pane seen before has closed.
      if (sideChat.mounted || !state.terminalLayoutsByTabId[sideChat.tabId]) {
        sideChatsBySideKey.delete(sideKey)
      }
      continue
    }
    sideChat.mounted = true
    if (!layoutHasLeaf(state, sideChat.tabId, sideChat.parentLeafId)) {
      sideChatsBySideKey.delete(sideKey)
      // Discarding the side chat is a consequence of closing its parent, so a paired host ends it too.
      closePane(sideChat.tabId, sideChat.sideLeafId, 'user')
      continue
    }
    const title = sideChatTitle(
      state.agentStatusByPaneKey[makePaneKey(sideChat.tabId, sideChat.parentLeafId)]
    )
    if (title !== sideChat.title) {
      sideChat.title = title
      const detail: SetTerminalPaneTitleDetail = {
        tabId: sideChat.tabId,
        leafId: sideChat.sideLeafId,
        title
      }
      window.dispatchEvent(new CustomEvent(SET_TERMINAL_PANE_TITLE_EVENT, { detail }))
    }
  }
}

/** A restored layout keeps side panes whose fork is gone, like Codex's expired side chats; close them. */
function closeOrphanedSideChats(state: AppState): void {
  for (const [paneKey, entry] of Object.entries(state.agentStatusByPaneKey)) {
    if (
      !isSideChatProviderSession(entry.agentType, entry.providerSession) ||
      sideChatsBySideKey.has(paneKey)
    ) {
      continue
    }
    const pane = parsePaneKey(paneKey)
    if (pane && layoutHasLeaf(state, pane.tabId, pane.leafId)) {
      closePane(pane.tabId, pane.leafId, 'cleanup')
    }
  }
}
