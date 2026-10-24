import type { WorktreeOccurrence } from '../worktree-occurrence-plan'
import type { FolderWorkspace } from '../folder-workspace-types'
import type { ProjectGroup } from '../project-group-types'
import type { Repo } from '../repo-types'
import type { DetectedWorktree, WorkspaceStatus, Worktree } from '../worktree/types'
import type { ExecutionHostId } from '../execution-host'
import type { PRGroupKey } from '../workspace-view/workspace-pr-groups'

export type WorktreeGroupBy = 'none' | 'workspace-status' | 'repo' | 'pr-status'
/** A row's own registration of its repo; the same repo id can be registered on several hosts. */
export type RepoOfWorktree = (worktree: Worktree) => Repo | undefined
export type PinnedWorktreeDisplayPolicy = 'single-location' | 'duplicate-in-groups'

export function getPinnedWorktreeDisplayPolicy(
  settings?: { showPinnedWorktreesInGroups?: boolean } | null
): PinnedWorktreeDisplayPolicy {
  return settings?.showPinnedWorktreesInGroups === true ? 'duplicate-in-groups' : 'single-location'
}

/** Which glyph a group header draws; each client maps it to its own icon and tone. */
export type SidebarHeaderIcon =
  | { kind: 'pinned' }
  | { kind: 'all' }
  | { kind: 'project' }
  | { kind: 'pr-status'; prGroup: PRGroupKey }
  | { kind: 'workspace-status'; status: WorkspaceStatus }

/** A worktree's PR lane, read by each client from its own PR facts. */
export type SidebarPRGroupReader = (worktree: Worktree) => PRGroupKey

export type GroupHeaderRow = {
  type: 'header'
  collapseKey?: string
  key: string
  /** Data label (project, project group, status); absent when the client names the header from its icon. */
  label?: string
  count: number
  icon: SidebarHeaderIcon
  repo?: Repo
  projectGroup?: ProjectGroup | { id: null; name: 'Ungrouped'; tabOrder: number }
  projectGroupDepth?: number
  hostId?: ExecutionHostId
  hostWorktreeCounts?: ReadonlyMap<ExecutionHostId, number>
  hostWorktreeIds?: ReadonlyMap<ExecutionHostId, readonly string[]>
  worktreeIds?: readonly string[]
  /** A workspace in this project has a running terminal. */
  running?: boolean
  /** Heads the active or idle part when running projects are lifted above idle ones. */
  runningSectionLabel?: 'active' | 'idle'
}

export type WorktreeRow = {
  occurrence?: WorktreeOccurrence<Worktree>
  type: 'item'
  rowKey: string
  sectionKey: string
  worktree: Worktree
  repo: Repo | undefined
  depth: number
  groupDepth: number
  isLastLineageChild: boolean
  lineageChildCount: number
  lineageGroupKey?: string
  lineageCollapsed?: boolean
  hostContextLabel?: string
  showProjectName?: boolean
}

export type ImportedWorktreesCardCandidate = {
  repo: Repo
  hiddenWorktrees: DetectedWorktree[]
}

export type ImportedWorktreesCardRow = {
  type: 'imported-worktrees-card'
  key: string
  repo: Repo
  hiddenWorktrees: DetectedWorktree[]
  placement: 'repo-group' | 'pinned-fallback'
  /** Set only when the row's project is checked out on more than one host. */
  hostContextLabel?: string
  hostContextHostId?: ExecutionHostId
}

export type NewExternalWorktreesInboxCandidate = {
  repo: Repo
  inboxWorktrees: DetectedWorktree[]
}

export type NewExternalWorktreesInboxRow = {
  type: 'new-external-worktrees-inbox'
  key: string
  repo: Repo
  inboxWorktrees: DetectedWorktree[]
  /** Set only when the row's project is checked out on more than one host. */
  hostContextLabel?: string
  hostContextHostId?: ExecutionHostId
}

export type PendingCreationRow = {
  type: 'pending-creation'
  key: string
  creationId: string
  repo: Repo | undefined
}

export type FolderWorkspaceRow = {
  type: 'folder-workspace'
  key: string
  folderWorkspace: FolderWorkspace
  projectGroup: ProjectGroup
  depth: number
  groupDepth: number
}

/** Minimal shape planSidebarRows needs for an in-flight create. Deliberately not the
 *  full PendingWorktreeCreation: row identity depends only on which creates
 *  exist and their repo, so callers can subscribe on this stable shape and keep
 *  progress-field churn (phase/loaderVisible) from rebuilding the whole list. */
export type PendingCreationRef = { creationId: string; repoId: string }

export type Row =
  | GroupHeaderRow
  | WorktreeRow
  | ImportedWorktreesCardRow
  | NewExternalWorktreesInboxRow
  | PendingCreationRow
  | FolderWorkspaceRow
