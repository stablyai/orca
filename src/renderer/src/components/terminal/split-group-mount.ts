import type { TabGroup, TabGroupLayoutNode } from '../../../../shared/tab-types'
import { readRecordChanges } from '@/store/keyed-record-change-reads'

export class MountedTerminalWorktrees extends Set<string> {
  private readonly changedIds = new Set<string>()
  private readonly committedChanges = {
    watcher: new Set<string>(),
    retention: new Set<string>()
  }

  private markChanged(id: string): void {
    this.changedIds.add(id)
    this.committedChanges.watcher.add(id)
    this.committedChanges.retention.add(id)
  }

  takeCommittedChanges(consumer: 'watcher' | 'retention'): ReadonlySet<string> {
    const changed = this.committedChanges[consumer]
    this.committedChanges[consumer] = new Set()
    return changed
  }

  constructor() {
    super()
  }

  override add(id: string): this {
    if (!this.has(id)) {
      this.markChanged(id)
    }
    return super.add(id)
  }

  override delete(id: string): boolean {
    if (!super.delete(id)) {
      return false
    }
    this.markChanged(id)
    return true
  }

  override clear(): void {
    for (const id of this) {
      this.delete(id)
    }
  }

  takeChangedIds(): ReadonlySet<string> {
    const changed = new Set(this.changedIds)
    this.changedIds.clear()
    return changed
  }
}

type LayoutPresence = {
  catalog: string[]
  catalogIds: ReadonlySet<string>
  layouts: Record<string, TabGroupLayoutNode | undefined>
  groups: Record<string, TabGroup[]>
  activeGroups: Record<string, string | undefined>
  present: Set<string>
}
const layoutPresenceByMounts = new WeakMap<ReadonlySet<string>, LayoutPresence>()

export function getEffectiveLayoutForWorktree(
  worktreeId: string,
  layoutByWorktree: Record<string, TabGroupLayoutNode | undefined>,
  groupsByWorktree: Record<string, readonly Pick<TabGroup, 'id'>[]>,
  activeGroupIdByWorktree: Record<string, string | undefined>
): TabGroupLayoutNode | undefined {
  const layout = layoutByWorktree[worktreeId]
  if (layout) {
    return layout
  }
  const groups = groupsByWorktree[worktreeId] ?? []
  const fallbackGroupId = activeGroupIdByWorktree[worktreeId] ?? groups[0]?.id ?? null
  if (!fallbackGroupId) {
    return undefined
  }
  return { type: 'leaf', groupId: fallbackGroupId } as const
}

/** The container owns every mounted worktree’s panes; gating on the active layout alone destroys background PaneManagers, buffers and PTYs during switches. */
export function anyMountedWorktreeHasLayout(
  allWorktreeIds: string[],
  mountedWorktreeIds: ReadonlySet<string>,
  layoutByWorktree: Record<string, TabGroupLayoutNode | undefined>,
  groupsByWorktree: Record<string, TabGroup[]>,
  activeGroupIdByWorktree: Record<string, string | undefined>
): boolean {
  const previous = layoutPresenceByMounts.get(mountedWorktreeIds)
  const catalogIds =
    previous?.catalog === allWorktreeIds ? previous.catalogIds : new Set(allWorktreeIds)
  let dirty =
    mountedWorktreeIds instanceof MountedTerminalWorktrees
      ? new Set(mountedWorktreeIds.takeChangedIds())
      : null
  if (previous && dirty) {
    for (const [before, after] of [
      [previous.layouts, layoutByWorktree],
      [previous.groups, groupsByWorktree],
      [previous.activeGroups, activeGroupIdByWorktree]
    ]) {
      const changed = readRecordChanges(after, before)
      if (changed?.kind === 'full-resync') {
        dirty = null
        break
      }
      for (const id of changed?.keys ?? []) {
        dirty.add(id)
      }
    }
  }
  // Bootstrap, catalog replacement and unknown source replacements cannot assume an addressed mount history.
  if (!previous || previous.catalog !== allWorktreeIds || dirty === null) {
    dirty = new Set([...mountedWorktreeIds, ...(previous?.present ?? [])])
  }
  const present = previous?.present ?? new Set<string>()
  for (const id of dirty) {
    if (
      catalogIds.has(id) &&
      mountedWorktreeIds.has(id) &&
      getEffectiveLayoutForWorktree(id, layoutByWorktree, groupsByWorktree, activeGroupIdByWorktree)
    ) {
      present.add(id)
    } else {
      present.delete(id)
    }
  }
  layoutPresenceByMounts.set(mountedWorktreeIds, {
    catalog: allWorktreeIds,
    catalogIds,
    layouts: layoutByWorktree,
    groups: groupsByWorktree,
    activeGroups: activeGroupIdByWorktree,
    present
  })
  return present.size > 0
}
