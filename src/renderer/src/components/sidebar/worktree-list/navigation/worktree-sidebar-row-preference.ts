import type { BotGroup } from '../../../../../../shared/bots/bot-group'
import {
  getFolderWorkspaceHostIdentity,
  getFolderWorkspaceWorktree
} from '../../../../../../shared/folder-workspaces/folder-workspace-worktree'
import {
  getWorktreeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../../../../../../shared/worktree/host-qualified-identity'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/hosts/host-section-rows'
import { PINNED_GROUP_KEY } from '../../../../../../shared/sidebar-list/sections/group-keys'
import type {
  PinnedWorktreeDisplayPolicy,
  WorktreeRow
} from '../../../../../../shared/sidebar-list/row-types'

export function getPreferredWorktreeRows(
  rows: readonly WorktreeRow[],
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
): WorktreeRow[] {
  // Navigation/selection treat pinned duplicates as one workspace, preferring a visible natural-group occurrence.
  if (pinnedDisplayPolicy === 'single-location') {
    const seen = new Set<string>()
    return rows.filter((row) => {
      const identity = getWorktreeHostIdentity(row.worktree)
      if (seen.has(identity)) {
        return false
      }
      seen.add(identity)
      return true
    })
  }

  const preferredRows: WorktreeRow[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const identity = getWorktreeHostIdentity(row.worktree)
    if (row.sectionKey === PINNED_GROUP_KEY || seen.has(identity)) {
      continue
    }
    preferredRows.push(row)
    seen.add(identity)
  }
  for (const row of rows) {
    const identity = getWorktreeHostIdentity(row.worktree)
    if (seen.has(identity)) {
      continue
    }
    preferredRows.push(row)
    seen.add(identity)
  }
  return preferredRows
}

export type RenderedWorkspaceRow = Pick<WorktreeRow, 'worktree' | 'repo' | 'rowKey'> & {
  section?: 'bots' | 'projects'
  botGroup?: BotGroup
}

/** Resolve host ownership like activation does; raw local rows omit hostId and would fail identity matching. */
export function getCyclableRowIdentity(row: RenderedWorkspaceRow): string {
  return composeWorktreeHostIdentity(
    getWorktreeExecutionHostId(row.worktree, row.repo),
    row.worktree.id
  )
}

export type SidebarCycleScope = 'section' | 'all'
export type SidebarCycleSection = 'bots' | 'projects'
export type LastActiveCycleWorkspace = {
  worktreeId: string
  executionHostId: ExecutionHostId | null
}
export type LastActiveSectionWorkspaces = Partial<
  Record<SidebarCycleSection, LastActiveCycleWorkspace>
>

export function dedupeCycleRows(rows: readonly RenderedWorkspaceRow[]): RenderedWorkspaceRow[] {
  const seen = new Set<string>()
  const deduped: RenderedWorkspaceRow[] = []
  for (const row of rows) {
    const identity = getCyclableRowIdentity(row)
    if (seen.has(identity)) {
      continue
    }
    seen.add(identity)
    deduped.push(row)
  }
  return deduped
}

export function resolveActiveSidebarSection(args: {
  botsRows: readonly RenderedWorkspaceRow[]
  projectsRows: readonly RenderedWorkspaceRow[]
  activeIdentity: string | null
  preferredSection?: SidebarCycleSection | null
  projectsFirst: boolean
}): SidebarCycleSection | null {
  const { botsRows, projectsRows, activeIdentity, preferredSection, projectsFirst } = args
  const inBots =
    activeIdentity !== null &&
    botsRows.some((row) => getCyclableRowIdentity(row) === activeIdentity)
  const inProjects =
    activeIdentity !== null &&
    projectsRows.some((row) => getCyclableRowIdentity(row) === activeIdentity)
  if (inBots && inProjects) {
    return preferredSection ?? 'projects'
  }
  if (inBots) {
    return 'bots'
  }
  if (inProjects) {
    return 'projects'
  }
  if (preferredSection === 'bots') {
    return botsRows.length > 0 ? 'bots' : null
  }
  if (preferredSection === 'projects') {
    return projectsRows.length > 0 ? 'projects' : null
  }
  const order: readonly SidebarCycleSection[] = projectsFirst
    ? ['projects', 'bots']
    : ['bots', 'projects']
  for (const section of order) {
    if ((section === 'bots' ? botsRows : projectsRows).length > 0) {
      return section
    }
  }
  return null
}

function forEachRenderedWorkspaceRow(
  rows: readonly HostSectionRow[],
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy,
  visitItem: (row: WorktreeRow) => void,
  visitFolderWorkspace: (row: Extract<HostSectionRow, { type: 'folder-workspace' }>) => void
): void {
  let nonPinnedIdentities: Set<string> | null = null
  if (pinnedDisplayPolicy !== 'single-location') {
    let hasPinned = false
    for (const row of rows) {
      if (row.type === 'item' && row.sectionKey === PINNED_GROUP_KEY) {
        hasPinned = true
        break
      }
    }
    if (hasPinned) {
      nonPinnedIdentities = new Set<string>()
      for (const row of rows) {
        if (row.type === 'item' && row.sectionKey !== PINNED_GROUP_KEY) {
          nonPinnedIdentities.add(getWorktreeHostIdentity(row.worktree))
        }
      }
    }
  }

  const emitted = new Set<string>()
  for (const row of rows) {
    if (row.type === 'item') {
      const identity = getWorktreeHostIdentity(row.worktree)
      if (
        nonPinnedIdentities !== null &&
        row.sectionKey === PINNED_GROUP_KEY &&
        nonPinnedIdentities.has(identity)
      ) {
        continue
      }
      if (emitted.has(identity)) {
        continue
      }
      emitted.add(identity)
      visitItem(row)
    } else if (row.type === 'folder-workspace') {
      visitFolderWorkspace(row)
    }
  }
}

export function getRenderedWorkspaceRowsInSidebarOrder(
  rows: readonly HostSectionRow[],
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
): RenderedWorkspaceRow[] {
  const renderedRows: RenderedWorkspaceRow[] = []
  forEachRenderedWorkspaceRow(
    rows,
    pinnedDisplayPolicy,
    (row) => {
      renderedRows.push({ worktree: row.worktree, repo: row.repo, rowKey: row.rowKey })
    },
    (row) => {
      renderedRows.push({
        worktree: getFolderWorkspaceWorktree(row.folderWorkspace),
        repo: undefined,
        rowKey: getFolderWorkspaceHostIdentity(row.folderWorkspace)
      })
    }
  )
  return renderedRows
}

export function getRenderedWorktreesInSidebarOrder(
  rows: readonly HostSectionRow[],
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
): Worktree[] {
  const renderedWorktrees: Worktree[] = []
  forEachRenderedWorkspaceRow(
    rows,
    pinnedDisplayPolicy,
    (row) => {
      renderedWorktrees.push(row.worktree)
    },
    (row) => {
      renderedWorktrees.push(getFolderWorkspaceWorktree(row.folderWorkspace))
    }
  )
  return renderedWorktrees
}
