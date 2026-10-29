import {
  CLOSE_TERMINAL_PANE_EVENT,
  SET_TERMINAL_PANE_TITLE_EVENT,
  type CloseTerminalPaneDetail,
  type SetTerminalPaneTitleDetail
} from '@/constants/terminal'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { makePaneKey, parsePaneKey } from '../../../shared/stable-pane-id'
import { collectLeafIds } from '../../../shared/terminal-pane-layout-tree'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { isClaudeSideChatSessionId } from '../../../shared/claude-side-chat-session-id'

export type ClaudeSideChat = {
  tabId: string
  parentLeafId: string
  sideLeafId: string
}

type TrackedSideChat = ClaudeSideChat & { mounted: boolean; title: string | null }

// Why in memory only: side chats are ephemeral, so a restart must not bring the pairing back.
const sideChatsBySideKey = new Map<string, TrackedSideChat>()
let lastStatuses: AppState['agentStatusByPaneKey'] | null = null
let lastLayouts: AppState['terminalLayoutsByTabId'] | null = null

/** App-lifetime watcher: keeps side titles current, closes side chats with their parent, and sweeps restored ones. */
export function installClaudeSideChatTracking(store = useAppStore): () => void {
  const unsubscribe = store.subscribe(syncClaudeSideChats)
  syncClaudeSideChats(store.getState())
  return () => {
    unsubscribe()
    lastStatuses = null
    lastLayouts = null
  }
}

export function registerClaudeSideChat(sideChat: ClaudeSideChat): void {
  sideChatsBySideKey.set(makePaneKey(sideChat.tabId, sideChat.sideLeafId), {
    ...sideChat,
    mounted: false,
    title: null
  })
}

export function findClaudeSideChatForParent(
  tabId: string,
  parentLeafId: string
): ClaudeSideChat | null {
  for (const sideChat of sideChatsBySideKey.values()) {
    if (sideChat.tabId === tabId && sideChat.parentLeafId === parentLeafId) {
      return sideChat
    }
  }
  return null
}

export function findClaudeSideChatBySide(tabId: string, sideLeafId: string): ClaudeSideChat | null {
  return sideChatsBySideKey.get(makePaneKey(tabId, sideLeafId)) ?? null
}

export function claudeSideChatTitle(parent: AgentStatusEntry | undefined): string {
  const base = translate('components.claudeSideChat.title', 'Side chat · from main')
  const status = parentStatusLabel(parent)
  return status ? `${base} · ${status}` : base
}

function parentStatusLabel(parent: AgentStatusEntry | undefined): string | null {
  switch (parent?.state) {
    case 'working':
      return translate('components.claudeSideChat.mainWorking', 'main working')
    case 'blocked':
      return translate('components.claudeSideChat.mainNeedsApproval', 'main needs approval')
    case 'waiting':
      return translate('components.claudeSideChat.mainNeedsInput', 'main needs input')
    case 'done':
      return parent.interrupted
        ? translate('components.claudeSideChat.mainInterrupted', 'main interrupted')
        : translate('components.claudeSideChat.mainFinished', 'main finished')
    case undefined:
      return null
  }
}

function layoutHasLeaf(state: AppState, tabId: string, leafId: string): boolean {
  return collectLeafIds(state.terminalLayoutsByTabId[tabId]?.root).includes(leafId)
}

const pendingCloses = new Set<string>()

function closePane(tabId: string, leafId: string): void {
  const key = makePaneKey(tabId, leafId)
  if (pendingCloses.has(key)) {
    return
  }
  pendingCloses.add(key)
  // Why deferred: closing re-enters the store, which is mid-notification here.
  setTimeout(() => {
    pendingCloses.delete(key)
    const detail: CloseTerminalPaneDetail = { tabId, leafId }
    window.dispatchEvent(new CustomEvent(CLOSE_TERMINAL_PANE_EVENT, { detail }))
  }, 0)
}

function syncClaudeSideChats(state: AppState): void {
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
      closePane(sideChat.tabId, sideChat.sideLeafId)
      continue
    }
    const title = claudeSideChatTitle(
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
    if (!isClaudeSideChatSessionId(entry.providerSession?.id) || sideChatsBySideKey.has(paneKey)) {
      continue
    }
    const pane = parsePaneKey(paneKey)
    if (pane && layoutHasLeaf(state, pane.tabId, pane.leafId)) {
      closePane(pane.tabId, pane.leafId)
    }
  }
}
