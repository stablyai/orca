import type { Tab } from '../../../../shared/tab-types'

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

export function projectActivityTabs(
  unifiedTabsByWorktree: Record<string, Tab[]> | undefined,
  previous: ActivityTabProjection | null
): ActivityTabProjection {
  const next: ActivityTabProjection = {}
  let changed = previous === null
  for (const [worktreeId, tabs] of Object.entries(unifiedTabsByWorktree ?? {})) {
    const relevant = tabs.filter(isActivityRelevantTab)
    if (relevant.length === 0) {
      continue
    }
    const prior = previous?.[worktreeId]
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
    if (reusable && prior) {
      next[worktreeId] = prior
    } else {
      next[worktreeId] = projected
      changed = true
    }
  }
  if (!changed && previous && Object.keys(previous).length === Object.keys(next).length) {
    return previous
  }
  return next
}
