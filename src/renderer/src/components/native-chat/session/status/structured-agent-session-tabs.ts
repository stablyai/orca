import { structuredAgentSessionPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import { isStructuredTab } from '../../../../../../shared/agent-session/view/structured-agent-session-tab'
import type { Tab } from '../../../../../../shared/tab-types'
import { readTabMapChanges } from '@/store/keyed-record-transitions'

export type StructuredTab = Tab & { contentType: 'agent-session' }

type TabsByWorktree = Record<string, Tab[]>
type Projection = {
  byWorktree: ReadonlyMap<string, readonly StructuredTab[]>
  tabs: readonly StructuredTab[]
}

const NO_TABS: readonly StructuredTab[] = Object.freeze([])
const structuredTabsByBucket = new WeakMap<readonly Tab[], readonly StructuredTab[]>()
const projectionsBySnapshot = new WeakMap<TabsByWorktree, Projection>()
let latest: { source: TabsByWorktree; projection: Projection } | null = null

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

function sameBuckets(
  previous: ReadonlyMap<string, readonly StructuredTab[]>,
  next: ReadonlyMap<string, readonly StructuredTab[]>
): boolean {
  if (previous.size !== next.size) {
    return false
  }
  const nextEntries = next.entries()
  for (const [worktreeId, tabs] of previous) {
    const entry = nextEntries.next().value
    if (entry?.[0] !== worktreeId || entry[1] !== tabs) {
      return false
    }
  }
  return true
}

// Cold path: bootstrap, hydration or an unannotated replacement; the only whole-map walk here.
function rebuildFromSnapshot(source: TabsByWorktree, previous: Projection | undefined): Projection {
  const byWorktree = new Map<string, readonly StructuredTab[]>()
  for (const worktreeId of Object.keys(source)) {
    const tabs = structuredTabsOf(source[worktreeId] ?? [], previous?.byWorktree.get(worktreeId))
    if (tabs.length) {
      byWorktree.set(worktreeId, tabs)
    }
  }
  return previous && sameBuckets(previous.byWorktree, byWorktree)
    ? previous
    : { byWorktree, tabs: [...byWorktree.values()].flat() }
}

function applyAddressed(
  source: TabsByWorktree,
  previous: Projection,
  workspaceIds: ReadonlySet<string>
): Projection {
  let byWorktree: Map<string, readonly StructuredTab[]> | null = null
  for (const worktreeId of workspaceIds) {
    const before = previous.byWorktree.get(worktreeId)
    const bucket = Object.hasOwn(source, worktreeId) ? source[worktreeId] : undefined
    const tabs = bucket ? structuredTabsOf(bucket, before) : NO_TABS
    if (tabs === (before ?? NO_TABS)) {
      continue
    }
    byWorktree ??= new Map(previous.byWorktree)
    if (tabs.length) {
      byWorktree.set(worktreeId, tabs)
    } else {
      byWorktree.delete(worktreeId)
    }
  }
  return byWorktree ? { byWorktree, tabs: [...byWorktree.values()].flat() } : previous
}

function project(source: TabsByWorktree): Projection {
  if (latest?.source === source) {
    return latest.projection
  }
  const cached = projectionsBySnapshot.get(source)
  if (cached) {
    return cached
  }
  const changes = latest ? readTabMapChanges(source, latest.source) : null
  const projection =
    latest && changes?.kind === 'addressed'
      ? applyAddressed(source, latest.projection, changes.workspaceIds)
      : rebuildFromSnapshot(source, latest?.projection)
  projectionsBySnapshot.set(source, projection)
  latest = { source, projection }
  return projection
}

/** Structured-session tabs; the same list while no chat tab changed, so non-chat tab writes stay quiet. */
export function getStructuredAgentSessionTabs(
  unifiedTabsByWorktree: TabsByWorktree
): readonly StructuredTab[] {
  return project(unifiedTabsByWorktree).tabs
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

/** One workspace's structured tabs, from the same per-bucket projection. */
export function getStructuredAgentSessionTabsInWorkspace(
  unifiedTabsByWorktree: TabsByWorktree,
  worktreeId: string
): readonly StructuredTab[] {
  return project(unifiedTabsByWorktree).byWorktree.get(worktreeId) ?? NO_TABS
}
