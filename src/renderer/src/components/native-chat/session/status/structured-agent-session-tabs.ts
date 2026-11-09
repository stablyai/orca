import { structuredAgentSessionPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import { isStructuredTab } from '../../../../../../shared/agent-session/view/structured-agent-session-tab'
import type { Tab } from '../../../../../../shared/tab-types'

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

function project(source: TabsByWorktree): Projection {
  if (latest?.source === source) {
    return latest.projection
  }
  const cached = projectionsBySnapshot.get(source)
  if (cached) {
    return cached
  }
  const previous = latest
  const byWorktree = new Map<string, readonly StructuredTab[]>()
  for (const worktreeId of Object.keys(source)) {
    const bucket = source[worktreeId] ?? []
    const previousTabs = previous?.projection.byWorktree.get(worktreeId)
    const tabs =
      previous?.source[worktreeId] === bucket
        ? (previousTabs ?? NO_TABS)
        : structuredTabsOf(bucket, previousTabs)
    if (tabs.length) {
      byWorktree.set(worktreeId, tabs)
    }
  }
  const projection =
    previous && sameBuckets(previous.projection.byWorktree, byWorktree)
      ? previous.projection
      : { byWorktree, tabs: [...byWorktree.values()].flat() }
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
