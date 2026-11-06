/** Which launch chats a workspace shows and where each tab sits in its group, indexed once per list.
 *  The store replaces a workspace's tab and group lists rather than editing them, so an index keyed
 *  by the list itself is rebuilt only when that list changes and is dropped along with it. */

import type { ExecutionHostId } from '../../../../../shared/execution-host'
import type { Tab, TabGroup } from '../../../../../shared/tab-types'

type ShownChat = { worktreeId: string; executionHostId: ExecutionHostId | undefined }
type TabMembership = { ids: Set<string>; chats: Map<string, ShownChat[]> }
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

/** This window just added `tab` to the list: its index moves to the new list with that one entry,
 *  rather than being rebuilt. Any other change to the list leaves it to be rebuilt when next read. */
export function noteLaunchTabDrawn(
  previous: readonly Tab[] | undefined,
  next: readonly Tab[] | undefined,
  tab: Tab
): void {
  const index = previous && tabIndexes.get(previous)
  if (!index || !next || next.length !== previous.length + 1 || index.ids.has(tab.id)) {
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
