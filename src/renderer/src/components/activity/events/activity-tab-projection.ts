import { readTabMapChanges } from '@/store/record-transitions/keyed-record-change-reads'
import { replaceTabBuckets } from '@/store/record-transitions/keyed-record-transitions'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'

/**
 * Stable view of the unified tab map for the activity pipeline.
 *
 * Terminal tabs reuse prior objects across focus-only writes. Native chats keep current
 * originals because the shared host-name projection uses those objects as keys.
 */
export type ActivityTabProjection = Record<string, Tab[]>

function isActivityRelevantTab(tab: Tab): boolean {
  return tab.contentType === 'terminal' || tab.contentType === 'agent-session'
}

function activityTabFieldsEqual(a: Tab, b: Tab): boolean {
  return (
    a.id === b.id &&
    a.entityId === b.entityId &&
    a.worktreeId === b.worktreeId &&
    a.executionHostId === b.executionHostId &&
    a.contentType === b.contentType &&
    a.label === b.label &&
    a.generatedLabel === b.generatedLabel &&
    a.customLabel === b.customLabel &&
    a.color === b.color &&
    a.isPinned === b.isPinned &&
    a.sortOrder === b.sortOrder &&
    a.createdAt === b.createdAt
  )
}

/** One workspace's relevant tabs; `prior` when they match it, null when none are relevant. */
function projectActivityTabBucket(tabs: readonly Tab[], prior: Tab[] | undefined): Tab[] | null {
  const relevant = tabs.filter(isActivityRelevantTab)
  if (relevant.length === 0) {
    return null
  }
  let reusable = prior !== undefined && prior.length === relevant.length
  const projected = relevant.map((tab, index) => {
    const priorTab = prior?.[index]
    if (
      priorTab &&
      (priorTab === tab ||
        (tab.contentType === 'terminal' && activityTabFieldsEqual(priorTab, tab)))
    ) {
      return priorTab
    }
    reusable = false
    return tab
  })
  return reusable && prior ? prior : projected
}

function projectActivityTabs(
  unifiedTabsByWorktree: Record<string, Tab[]> | undefined,
  previous: ActivityTabProjection | null
): ActivityTabProjection {
  const next: ActivityTabProjection = {}
  let changed = previous === null
  for (const [worktreeId, tabs] of Object.entries(unifiedTabsByWorktree ?? {})) {
    const prior = previous?.[worktreeId]
    const projected = projectActivityTabBucket(tabs, prior)
    if (!projected) {
      continue
    }
    next[worktreeId] = projected
    changed ||= projected !== prior
  }
  // Later bucket patches keep this key order, so a reorder alone must still publish the new order.
  return !changed && previous && sameKeyOrder(previous, next) ? previous : next
}

function sameKeyOrder(a: ActivityTabProjection, b: ActivityTabProjection): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  return aKeys.length === bKeys.length && aKeys.every((key, index) => key === bKeys[index])
}

/**
 * Advances `previous` (projected from `previousSource`) to `source`, touching only the buckets an
 * annotated write replaced. The result carries the same annotation, so its readers can patch too.
 */
export function advanceActivityTabs(
  source: Record<string, Tab[]>,
  previousSource: Record<string, Tab[]> | null,
  previous: ActivityTabProjection | null
): ActivityTabProjection {
  if (!previous || !previousSource) {
    return projectActivityTabs(source, previous)
  }
  const changes = readTabMapChanges(source, previousSource)
  if (!changes) {
    return previous
  }
  if (changes.kind !== 'addressed' || changes.workspaceSetChanged) {
    return projectActivityTabs(source, previous)
  }
  const replacements: [string, Tab[]][] = []
  for (const worktreeId of changes.workspaceIds) {
    const prior = Object.hasOwn(previous, worktreeId) ? previous[worktreeId] : undefined
    const bucket = Object.hasOwn(source, worktreeId) ? source[worktreeId] : undefined
    const projected = bucket ? projectActivityTabBucket(bucket, prior) : null
    // A workspace gaining or losing its only relevant tab moves in key order; the full pass places it.
    if (!projected !== !prior) {
      return projectActivityTabs(source, previous)
    }
    if (projected && projected !== prior) {
      replacements.push([worktreeId, projected])
    }
  }
  return replacements.length ? replaceTabBuckets(previous, replacements) : previous
}
