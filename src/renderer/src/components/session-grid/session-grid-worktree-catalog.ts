import {
  resolveWorktreeBranchLabel,
  resolveWorktreeDisplayName
} from '@/lib/worktree-default-display-name'
import { getIndexedRepoMap } from '@/store/worktree-repo-index'
import {
  createExecutionHostLabelResolver,
  resolveRemoteExecutionHostKind,
  type ExecutionHostLabelSources
} from '@/lib/workspace-execution-host'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import {
  getWorktreeExecutionHostId,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import type { SessionGridHostKind } from '../../../../shared/session-grid-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { translate } from '@/i18n/i18n'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'

/** Whatever names the host a workspace's worktree inherits: its repo, or its folder group. */
type WorkspaceHostOwner = { connectionId?: string | null; executionHostId?: string | null }

export type SessionGridWorktreeEntry = {
  worktreeId: string
  worktreeName: string
  repoId: string
  repoName: string
  /** Absent for a folder workspace, which has no branch. */
  branch?: string
  path: string
  /** `repo / worktree`, collapsed to the name alone when the two coincide (a default checkout). */
  label: string
  /** Where this workspace's work runs; `local` covers WSL too, which no catalog can tell apart. */
  hostKind: SessionGridHostKind
  executionHostId: ExecutionHostId
  /** The remote host's display name, absent on a local one — there is nothing to name. */
  hostLabel?: string
}

export type SessionGridRepoGroup = {
  repoId: string
  repoName: string
  worktrees: SessionGridWorktreeEntry[]
}

export type SessionGridWorktreeCatalog = {
  byWorktreeId: Map<string, SessionGridWorktreeEntry>
  entriesByWorktreeId: Map<string, SessionGridWorktreeEntry[]>
  /** Repo-grouped, in catalog order; what the launch menus render. */
  byRepo: SessionGridRepoGroup[]
  /**
   * Names a host the entries never mention — a card whose pty runs somewhere its
   * workspace does not. Lives here because the label sources are the catalog's own
   * inputs, so the builder can ask without reading the store a second time.
   */
  resolveHostLabel: (executionHostId: ExecutionHostId) => string | undefined
}

/** Stand-in for a workspace the catalogs no longer know, e.g. a tab left over from a removed repo. */
export function unknownWorktreeLabel(): string {
  return translate(
    'auto.components.session.grid.session.grid.worktree.catalog.bdc7918d99',
    'Workspace'
  )
}

function unknownRepoLabel(): string {
  return translate(
    'auto.components.session.grid.session.grid.worktree.catalog.3c706dc992',
    'Project'
  )
}

export function sessionGridWorktreeLabel(entry: SessionGridWorktreeEntry | undefined): string {
  return entry?.label ?? unknownWorktreeLabel()
}

/**
 * `project / workspace`, or the name alone when the two coincide (a default checkout named
 * after its repo). The one spelling of a workspace's identity: the catalog label, the
 * toolbar's scope picker and the card header all read it from here.
 */
export function sessionGridWorkspaceIdentity(repoName: string, worktreeName: string): string {
  return worktreeName !== repoName ? `${repoName} / ${worktreeName}` : worktreeName
}

/** The branch beside a workspace's name only when it says something the name does not. */
export function sessionGridBranchMeta(
  workspace: { worktreeName: string; branch?: string } | undefined
): string | null {
  return workspace?.branch && workspace.branch !== workspace.worktreeName ? workspace.branch : null
}

/** One pass over the workspace catalogs; every grid surface that names a worktree reads from this. */
export function buildSessionGridWorktreeCatalog({
  worktreesByRepo,
  repos,
  folderWorkspaces = [],
  projectGroups = [],
  ...hostLabelSources
}: {
  worktreesByRepo: Record<string, Worktree[]>
  repos: readonly Repo[]
  /** Launch targets too, and they live outside `worktreesByRepo`. */
  folderWorkspaces?: readonly FolderWorkspace[]
  /** Names the folder-workspace groups the way repos name theirs. */
  projectGroups?: readonly ProjectGroup[]
} & ExecutionHostLabelSources): SessionGridWorktreeCatalog {
  const repoById = getIndexedRepoMap(repos)
  const byWorktreeId = new Map<string, SessionGridWorktreeEntry>()
  const entriesByWorktreeId = new Map<string, SessionGridWorktreeEntry[]>()
  const identities = new Set<string>()
  const byRepo: SessionGridRepoGroup[] = []
  const resolveHostLabel = createExecutionHostLabelResolver(hostLabelSources)

  const collect = (
    repoId: string,
    repoName: string,
    worktrees: readonly Worktree[],
    hostOwnerFor: (worktree: Worktree) => WorkspaceHostOwner | undefined
  ): void => {
    const group: SessionGridRepoGroup = { repoId, repoName, worktrees: [] }
    for (const wt of worktrees) {
      const worktreeName = resolveWorktreeDisplayName(wt)
      const hostOwner = hostOwnerFor(wt)
      // A group's `executionHostId` is a raw string; only a parseable one can stand in as the host id.
      const executionHostId = getWorktreeExecutionHostId(wt, {
        connectionId: hostOwner?.connectionId ?? null,
        executionHostId: normalizeExecutionHostId(hostOwner?.executionHostId)
      })
      const identity = composeWorktreeHostIdentity(executionHostId, wt.id)
      if (identities.has(identity)) {
        continue
      }
      identities.add(identity)
      const entry: SessionGridWorktreeEntry = {
        worktreeId: wt.id,
        worktreeName,
        repoId,
        repoName,
        branch: resolveWorktreeBranchLabel(wt) || undefined,
        path: wt.path,
        label: sessionGridWorkspaceIdentity(repoName, worktreeName),
        hostKind:
          resolveRemoteExecutionHostKind(
            hostOwner?.connectionId,
            wt.hostId ?? hostOwner?.executionHostId
          ) ?? 'local',
        executionHostId,
        hostLabel: resolveHostLabel(executionHostId)
      }
      byWorktreeId.set(wt.id, entry)
      const entries = entriesByWorktreeId.get(wt.id) ?? []
      entries.push(entry)
      entriesByWorktreeId.set(wt.id, entries)
      group.worktrees.push(entry)
    }
    // Why only non-empty: `byRepo` is what the launch pickers render, and a repo
    // whose worktrees are all gone is a header with nothing selectable under it.
    if (group.worktrees.length > 0) {
      byRepo.push(group)
    }
  }

  for (const [repoId, worktrees] of Object.entries(worktreesByRepo)) {
    const repo = repoById.get(repoId)
    collect(repoId, repo?.displayName ?? unknownRepoLabel(), worktrees, () => repo)
  }

  // Why projected: a folder workspace is `folder:<id>` in every tab and pty map
  // — a launchable workspace like any other, just not one a repo scan returns.
  const foldersByGroupId = new Map<string, Worktree[]>()
  // A folder workspace with no host of its own inherits its group's, the way a worktree inherits its repo's.
  const hostOwnerByWorktreeId = new Map<string, WorkspaceHostOwner>()
  const groupById = new Map(projectGroups.map((group) => [group.id, group]))
  for (const workspace of folderWorkspaces) {
    const projected = folderWorkspaceToWorktree(workspace)
    const group = groupById.get(workspace.projectGroupId)
    hostOwnerByWorktreeId.set(projected.id, {
      connectionId: workspace.connectionId ?? group?.connectionId ?? null,
      executionHostId: workspace.executionHostId ?? group?.executionHostId ?? null
    })
    const siblings = foldersByGroupId.get(workspace.projectGroupId)
    if (siblings) {
      siblings.push(projected)
    } else {
      foldersByGroupId.set(workspace.projectGroupId, [projected])
    }
  }
  for (const [projectGroupId, worktrees] of foldersByGroupId) {
    // The projection already namespaces the group id; take it from there rather than rebuilding it.
    collect(
      worktrees[0].repoId,
      groupById.get(projectGroupId)?.name ?? unknownRepoLabel(),
      worktrees,
      (wt) => hostOwnerByWorktreeId.get(wt.id)
    )
  }
  return { byWorktreeId, entriesByWorktreeId, byRepo, resolveHostLabel }
}
