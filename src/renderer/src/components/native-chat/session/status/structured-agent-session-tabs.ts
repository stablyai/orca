import { structuredAgentSessionPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import { isStructuredTab } from '../../../../../../shared/agent-session/view/structured-agent-session-tab'
import type { Tab } from '../../../../../../shared/tab-types'
import { readTabMapChanges } from '@/store/keyed-record-transitions'

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
  list: readonly StructuredTab[] | null
  /** The last materialized list, reused when a rebuild yields the same chats. */
  stale: readonly StructuredTab[] | null
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

function setChats(target: Lineage, worktreeId: string, tabs: readonly StructuredTab[]): void {
  if (tabs === (target.chats.get(worktreeId) ?? NO_TABS)) {
    return
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
    list: null,
    stale: previous?.list ?? previous?.stale ?? null
  }
  for (const worktreeId of Object.keys(source)) {
    rebuilt.rank.set(worktreeId, rebuilt.nextRank++)
    const tabs = structuredTabsOf(source[worktreeId] ?? [], previous?.chats.get(worktreeId))
    if (tabs.length) {
      rebuilt.chats.set(worktreeId, tabs)
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
  for (const worktreeId of changes.deletedWorkspaceIds) {
    target.rank.delete(worktreeId)
  }
  for (const worktreeId of changes.addedWorkspaceIds) {
    target.rank.set(worktreeId, target.nextRank++)
  }
  for (const worktreeId of changes.workspaceIds) {
    const bucket = Object.hasOwn(source, worktreeId) ? source[worktreeId] : undefined
    setChats(
      target,
      worktreeId,
      bucket ? structuredTabsOf(bucket, target.chats.get(worktreeId)) : NO_TABS
    )
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
    const rank = (worktreeId: string) => current.rank.get(worktreeId) ?? 0
    const built = [...current.chats.keys()]
      .sort((a, b) => rank(a) - rank(b))
      .flatMap((worktreeId) => current.chats.get(worktreeId) ?? NO_TABS)
    current.list = current.stale && sameTabs(current.stale, built) ? current.stale : built
    current.stale = null
  }
  return current.list
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

const paneTabs = new WeakMap<readonly StructuredTab[], ReadonlyMap<string, StructuredTab>>()
export function getStructuredAgentSessionTabsByPaneKey(
  tabs: TabsByWorktree
): ReadonlyMap<string, StructuredTab> {
  const structuredTabs = getStructuredAgentSessionTabs(tabs)
  const cached = paneTabs.get(structuredTabs)
  if (cached) {
    return cached
  }
  const result = new Map(
    structuredTabs.map((tab) => [structuredAgentSessionPaneKey(tab.id, tab.entityId), tab])
  )
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
