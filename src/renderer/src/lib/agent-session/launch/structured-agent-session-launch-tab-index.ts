/** Which launch chats a workspace shows and where each tab sits in its group, indexed once per list.
 *  The store replaces a workspace's tab and group lists rather than editing them, so an index keyed
 *  by the list itself is rebuilt only when that list changes and is dropped along with it. */

import type { ExecutionHostId } from '../../../../../shared/execution-host'
import type { Tab, TabGroup } from '../../../../../shared/tab-types'
import {
  HOST_TERMINAL_SURFACE_SEPARATOR,
  toHostSessionTabId
} from '../../../../../shared/workspace-layout/terminal-surface-id'

type ShownChat = { worktreeId: string; executionHostId: ExecutionHostId | undefined }
type TabMembership = {
  ids: Set<string>
  chats: Map<string, ShownChat[]>
  /** Host tab id → the first terminal tab drawn for it; built on first read. */
  terminals?: Map<string, string>
}
type OrderSlot = { group: TabGroup; position: number }

const tabIndexes = new WeakMap<readonly Tab[], TabMembership>()
const groupIndexes = new WeakMap<readonly TabGroup[], Map<string, OrderSlot>>()

function addTab(index: TabMembership, tab: Tab): void {
  index.ids.add(tab.id)
  if (tab.contentType === 'agent-session') {
    const shown = { worktreeId: tab.worktreeId, executionHostId: tab.executionHostId }
    const chats = index.chats.get(tab.entityId)
    if (chats) {
      chats.push(shown)
    } else {
      index.chats.set(tab.entityId, [shown])
    }
  }
  if (index.terminals) {
    addTerminal(index.terminals, tab)
  }
}

// A paired host's terminal is drawn under a mirrored id that decodes to the host's tab.
const hostTabOf = (id: string): string =>
  toHostSessionTabId(id).split(HOST_TERMINAL_SURFACE_SEPARATOR)[0]

/** Keeps the first tab per host tab id, so a later tab never shadows an earlier match. */
function addTerminal(terminals: Map<string, string>, tab: Tab): void {
  if (tab.contentType !== 'terminal') {
    return
  }
  for (const id of tab.entityId === tab.id ? [tab.id] : [tab.id, tab.entityId]) {
    const hostTabId = hostTabOf(id)
    if (!terminals.has(hostTabId)) {
      terminals.set(hostTabId, tab.id)
    }
  }
}

function tabMembership(tabs: readonly Tab[]): TabMembership {
  let index = tabIndexes.get(tabs)
  if (!index) {
    index = { ids: new Set(), chats: new Map() }
    for (const tab of tabs) {
      addTab(index, tab)
    }
    tabIndexes.set(tabs, index)
  }
  return index
}

export function workspaceTabIdShown(tabs: readonly Tab[] | undefined, tabId: string): boolean {
  return !!tabs && tabMembership(tabs).ids.has(tabId)
}

/** A chat tab for the session in this workspace on `executionHostId`; a tab naming no host counts
 *  as `owner`'s, the host its launch was sent to. */
export function workspaceShowsLaunchChat(
  tabs: readonly Tab[] | undefined,
  args: { worktreeId: string; sessionId: string; executionHostId: ExecutionHostId },
  owner: ExecutionHostId | undefined
): boolean {
  return (
    !!tabs &&
    (tabMembership(tabs).chats.get(args.sessionId) ?? []).some(
      (chat) =>
        chat.worktreeId === args.worktreeId &&
        (chat.executionHostId ?? owner) === args.executionHostId
    )
  )
}

/** The first terminal tab, in list order, drawn for the host's tab `hostTabId` under its own or a
 *  mirrored id or entity id. Each terminal is decoded once per list, however many launches ask. */
export function workspaceTerminalForHostTab(
  tabs: readonly Tab[] | undefined,
  hostTabId: string
): string | undefined {
  if (!tabs) {
    return undefined
  }
  const index = tabMembership(tabs)
  if (!index.terminals) {
    const terminals = new Map<string, string>()
    for (const tab of tabs) {
      addTerminal(terminals, tab)
    }
    index.terminals = terminals
  }
  return index.terminals.get(hostTabId)
}

/** This window just appended `tab` to the list: its index moves to the new list with that one entry,
 *  rather than being rebuilt. Any other change to the list leaves it to be rebuilt when next read;
 *  the old list loses its index, so it is rebuilt rather than read with the new tab in it. */
export function noteLaunchTabDrawn(
  previous: readonly Tab[] | undefined,
  next: readonly Tab[] | undefined,
  tab: Tab
): void {
  const index = previous && tabIndexes.get(previous)
  if (
    !index ||
    !next ||
    next.length !== previous.length + 1 ||
    next.at(-1) !== tab ||
    index.ids.has(tab.id)
  ) {
    return
  }
  tabIndexes.delete(previous)
  addTab(index, tab)
  tabIndexes.set(next, index)
}

/** The first group whose order holds the tab, and the tab's first place in it. */
export function groupHoldingTab(
  groups: readonly TabGroup[] | undefined,
  tabId: string
): OrderSlot | undefined {
  if (!groups) {
    return undefined
  }
  let index = groupIndexes.get(groups)
  if (!index) {
    index = new Map()
    for (const group of groups) {
      group.tabOrder.forEach((id, position) => {
        if (!index!.has(id)) {
          index!.set(id, { group, position })
        }
      })
    }
    groupIndexes.set(groups, index)
  }
  return index.get(tabId)
}
