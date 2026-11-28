import { isStructuredTab } from '../../../../../../shared/agent-session/view/structured-agent-session-tab'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import { readTabMapChanges } from '@/store/record-transitions/keyed-record-change-reads'
import { readTabRowChanges } from '@/store/record-transitions/keyed-tab-row-changes'
import { chatPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'

export type StructuredTab = Tab & { contentType: 'agent-session' }

type TabsByWorktree = Record<string, Tab[]>

const NO_TABS: readonly StructuredTab[] = Object.freeze([])
const structuredTabsByBucket = new WeakMap<readonly Tab[], readonly StructuredTab[]>()
const listsBySnapshot = new WeakMap<TabsByWorktree, readonly StructuredTab[]>()
const INDEX_KEY = /^(?:0|[1-9]\d*)$/

/**
 * The latest source's chat subsets, kept only for chat-bearing workspaces, plus each source
 * workspace's rank. Ranks change only when a workspace is added or deleted, so a focus, label or
 * title write costs O(that workspace) and the list keeps source order.
 */
type Lineage = {
  source: TabsByWorktree
  rank: Map<string, number>
  nextRank: number
  chats: Map<string, readonly StructuredTab[]>
  /** Chat-bearing workspaces in rank order; changes only when one gains its first or loses its last chat. */
  order: string[] | null
  list: readonly StructuredTab[] | null
  /** The last materialized list, reused when a rebuild yields the same chats. */
  stale: readonly StructuredTab[] | null
  /** Open tabs per conversation pane key, kept with `chats` so a close never walks every tab. */
  byConversation: Map<string, Map<string, Tab>>
}
let lineage: Lineage | null = null

function sameTabs(previous: readonly StructuredTab[], next: readonly StructuredTab[]): boolean {
  return previous.length === next.length && previous.every((tab, index) => tab === next[index])
}

// A terminal title or focus write replaces its bucket; keep the chat subset when no chat changed.
function structuredTabsOf(
  bucket: readonly Tab[],
  previous: readonly StructuredTab[] | undefined
): readonly StructuredTab[] {
  const cached = structuredTabsByBucket.get(bucket)
  if (cached) {
    return cached
  }
  const tabs = bucket.filter(isStructuredTab)
  const result = !tabs.length ? NO_TABS : previous && sameTabs(previous, tabs) ? previous : tabs
  structuredTabsByBucket.set(bucket, result)
  return result
}

function rankOf(target: Lineage, worktreeId: string): number {
  return target.rank.get(worktreeId) ?? 0
}

// Insert or drop one workspace in the cached order: O(log K) to find, one splice to place.
function placeInOrder(target: Lineage, worktreeId: string, present: boolean): void {
  const order = target.order
  if (!order) {
    return
  }
  const rank = rankOf(target, worktreeId)
  let low = 0
  let high = order.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (rankOf(target, order[middle]) < rank) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  if (present) {
    order.splice(low, 0, worktreeId)
  } else if (order[low] === worktreeId) {
    order.splice(low, 1)
  } else {
    target.order = null
  }
}

function updateConversationTab(
  { byConversation }: Lineage,
  worktreeId: string,
  tabId: string,
  before: Tab | undefined,
  after: Tab | undefined
): void {
  if (
    before === after ||
    (before?.contentType !== 'agent-session' && after?.contentType !== 'agent-session')
  ) {
    return
  }
  const slot = `${worktreeId}\0${tabId}`
  if (
    before?.contentType === 'agent-session' &&
    (after?.contentType !== 'agent-session' || before.entityId !== after.entityId)
  ) {
    const key = chatPaneKey(before.entityId)
    const showing = byConversation.get(key)
    if (showing?.delete(slot) && showing.size === 0) {
      byConversation.delete(key)
    }
  }
  if (after?.contentType === 'agent-session') {
    const key = chatPaneKey(after.entityId)
    const showing = byConversation.get(key)
    if (showing) {
      // Refresh row metadata in place without changing its conversation membership.
      showing.set(slot, after)
    } else {
      byConversation.set(key, new Map([[slot, after]]))
    }
  }
}

function setChats(target: Lineage, worktreeId: string, tabs: readonly StructuredTab[]): void {
  const before = target.chats.get(worktreeId) ?? NO_TABS
  if (tabs === before) {
    return
  }
  if (!before.length !== !tabs.length) {
    placeInOrder(target, worktreeId, tabs.length > 0)
  }
  if (tabs.length) {
    target.chats.set(worktreeId, tabs)
  } else {
    target.chats.delete(worktreeId)
  }
  target.stale = target.list ?? target.stale
  target.list = null
}

// Cold path: bootstrap, hydration, an unannotated or reordering replacement; the only whole-map walk.
function rebuildFromSnapshot(source: TabsByWorktree, previous: Lineage | null): Lineage {
  const rebuilt: Lineage = {
    source,
    rank: new Map(),
    nextRank: 0,
    chats: new Map(),
    order: null,
    list: null,
    stale: previous?.list ?? previous?.stale ?? null,
    byConversation: new Map()
  }
  for (const worktreeId of Object.keys(source)) {
    rebuilt.rank.set(worktreeId, rebuilt.nextRank++)
    const bucket = source[worktreeId] ?? []
    const tabs = structuredTabsOf(bucket, previous?.chats.get(worktreeId))
    if (tabs.length) {
      rebuilt.chats.set(worktreeId, tabs)
    }
    for (const tab of bucket) {
      updateConversationTab(rebuilt, worktreeId, tab.id, undefined, tab)
    }
  }
  return rebuilt
}

/** False when the change can't be placed by ranks alone (an index-like workspace key). */
function applyAddressed(
  target: Lineage,
  source: TabsByWorktree,
  changes: Extract<ReturnType<typeof readTabMapChanges>, { kind: 'addressed' }>
): boolean {
  if (changes.addedWorkspaceIds.some((worktreeId) => INDEX_KEY.test(worktreeId))) {
    return false
  }
  for (const worktreeId of changes.addedWorkspaceIds) {
    target.rank.set(worktreeId, target.nextRank++)
  }
  const changedRows = readTabRowChanges(source, target.source)
  for (const worktreeId of changes.workspaceIds) {
    const bucket = Object.hasOwn(source, worktreeId) ? source[worktreeId] : undefined
    if (changedRows === 'unknown') {
      // A reorder can hide row provenance, but the changed tab IDs are still available.
      const previous = Object.hasOwn(target.source, worktreeId) ? target.source[worktreeId] : []
      const before = new Map<string, Tab>()
      for (const tab of previous) {
        if (changes.tabIds.has(tab.id) && tab.contentType === 'agent-session') {
          before.set(tab.id, tab)
        }
      }
      for (const tab of bucket ?? []) {
        if (changes.tabIds.has(tab.id) && tab.contentType === 'agent-session') {
          updateConversationTab(target, worktreeId, tab.id, before.get(tab.id), tab)
          before.delete(tab.id)
        }
      }
      for (const [tabId, tab] of before) {
        updateConversationTab(target, worktreeId, tabId, tab, undefined)
      }
    } else {
      for (const [tabId, row] of changedRows?.get(worktreeId) ?? []) {
        updateConversationTab(target, worktreeId, tabId, row.before, row.after)
      }
    }
    setChats(
      target,
      worktreeId,
      bucket ? structuredTabsOf(bucket, target.chats.get(worktreeId)) : NO_TABS
    )
  }
  // Ranks of deleted workspaces go after their chats leave the cached order.
  for (const worktreeId of changes.deletedWorkspaceIds) {
    target.rank.delete(worktreeId)
  }
  target.source = source
  return true
}

function advance(source: TabsByWorktree): Lineage {
  if (lineage?.source === source) {
    return lineage
  }
  const changes = lineage ? readTabMapChanges(source, lineage.source) : null
  if (!(lineage && changes?.kind === 'addressed' && applyAddressed(lineage, source, changes))) {
    lineage = rebuildFromSnapshot(source, lineage)
  }
  return lineage
}

function materialize(current: Lineage): readonly StructuredTab[] {
  if (!current.list) {
    // Sorted only after a full resync; ordinary chat edits reuse the cached order.
    current.order ??= [...current.chats.keys()].sort(
      (a, b) => rankOf(current, a) - rankOf(current, b)
    )
    const built = current.order.flatMap((worktreeId) => current.chats.get(worktreeId) ?? NO_TABS)
    current.list = current.stale && sameTabs(current.stale, built) ? current.stale : built
    current.stale = null
  }
  return current.list
}

const NO_CONVERSATION_TABS: ReadonlyMap<string, Tab> = new Map()

/** Every open tab showing the conversation with this pane key, in any workspace. */
export function chatTabsShowingConversation(
  unifiedTabsByWorktree: TabsByWorktree,
  paneKey: string
): Iterable<Tab> {
  return (
    advance(unifiedTabsByWorktree).byConversation.get(paneKey) ?? NO_CONVERSATION_TABS
  ).values()
}

export function* structuredTabsShowingConversation(
  unifiedTabsByWorktree: TabsByWorktree,
  paneKey: string
): IterableIterator<StructuredTab> {
  for (const tab of chatTabsShowingConversation(unifiedTabsByWorktree, paneKey)) {
    if (isStructuredTab(tab)) {
      yield tab
    }
  }
}

/** Structured-session tabs; the same list while no chat tab changed, so non-chat tab writes stay quiet. */
export function getStructuredAgentSessionTabs(
  unifiedTabsByWorktree: TabsByWorktree
): readonly StructuredTab[] {
  const cached = listsBySnapshot.get(unifiedTabsByWorktree)
  if (cached) {
    return cached
  }
  const list = materialize(advance(unifiedTabsByWorktree))
  listsBySnapshot.set(unifiedTabsByWorktree, list)
  return list
}

/** A chat tab's pane key: its conversation's, whatever tab it sits in. */
export function structuredTabPaneKey(tab: StructuredTab): string {
  return chatPaneKey(tab.entityId)
}

const emptyPaneTabs: ReadonlyMap<string, StructuredTab> = new Map()
const paneTabs = new WeakMap<readonly StructuredTab[], ReadonlyMap<string, StructuredTab>>()
export function getStructuredAgentSessionTabsByPaneKey(
  tabs: TabsByWorktree | Tab[] | undefined
): ReadonlyMap<string, StructuredTab> {
  if (!tabs) {
    return emptyPaneTabs
  }
  return structuredTabsByPaneKey(
    Array.isArray(tabs) ? structuredTabsOf(tabs, undefined) : getStructuredAgentSessionTabs(tabs)
  )
}

/** A chat list's tabs by pane key, built once per list identity. */
export function structuredTabsByPaneKey(
  structuredTabs: readonly StructuredTab[]
): ReadonlyMap<string, StructuredTab> {
  const cached = paneTabs.get(structuredTabs)
  if (cached) {
    return cached
  }
  // The first listed tab stands for a conversation, as the status member and projection do.
  const result = new Map<string, StructuredTab>()
  for (const tab of structuredTabs) {
    const key = chatPaneKey(tab.entityId)
    if (!result.has(key)) {
      result.set(key, tab)
    }
  }
  paneTabs.set(structuredTabs, result)
  return result
}

/** One workspace's structured tabs, from the same addressed projection. */
export function getStructuredAgentSessionTabsInWorkspace(
  unifiedTabsByWorktree: TabsByWorktree,
  worktreeId: string
): readonly StructuredTab[] {
  return advance(unifiedTabsByWorktree).chats.get(worktreeId) ?? NO_TABS
}
