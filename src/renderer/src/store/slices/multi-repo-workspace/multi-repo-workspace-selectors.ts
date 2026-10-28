import type { FolderWorkspace } from '../../../../../shared/folder-workspace-types'
import type {
  MultiRepoMember,
  MultiRepoWorkspace
} from '../../../../../shared/multi-repo-workspace'
import type { Repo } from '../../../../../shared/repo-types'
import { resolveMultiRepoExecutionHostId } from '@/lib/multi-repo-execution-host'
import {
  composeWorktreeHostIdentity,
  type HostScopedWorktreeKey
} from '../../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../../shared/worktree/types'

export type MultiRepoMemberAvailability = 'ok' | 'project_removed' | 'missing'

export type MultiRepoMemberView = {
  member: MultiRepoMember
  repo: Repo | undefined
  worktree: Worktree | undefined
  availability: MultiRepoMemberAvailability
}

export type MultiRepoWorkspaceSummary = {
  total: number
  creating: number
  queued: number
  ready: number
  failed: number
  interrupted: number
  missing: number
  /** Members that still hold a worktree to remove. */
  remaining: number
  changed: number
  withChanges: number
}

export function getMultiRepoWorkspace(
  workspace: Pick<FolderWorkspace, 'multiRepo'> | null | undefined
): MultiRepoWorkspace | null {
  return workspace?.multiRepo ?? null
}

export function isMultiRepoWorkspace(
  workspace: Pick<FolderWorkspace, 'multiRepo'> | null | undefined
): boolean {
  return getMultiRepoWorkspace(workspace) !== null
}

function getMemberAvailability(
  member: MultiRepoMember,
  repo: Repo | undefined,
  worktrees: readonly Worktree[] | undefined,
  worktree: Worktree | undefined
): MultiRepoMemberAvailability {
  if (!repo) {
    return 'project_removed'
  }
  // A repo whose worktree list has not loaded yet is not evidence that the worktree is gone.
  return member.state === 'ready' && member.worktreeId && worktrees && !worktree ? 'missing' : 'ok'
}

export function deriveMultiRepoMemberViews(
  workspace: Pick<FolderWorkspace, 'multiRepo'>,
  repos: readonly Repo[],
  worktreesByRepo: Readonly<Record<string, readonly Worktree[] | undefined>>
): MultiRepoMemberView[] {
  const multiRepo = getMultiRepoWorkspace(workspace)
  if (!multiRepo) {
    return []
  }
  return multiRepo.members.map((member) => {
    const repo = repos.find((candidate) => candidate.id === member.repoId)
    const worktrees = worktreesByRepo[member.repoId]
    const worktree = member.worktreeId
      ? worktrees?.find((candidate) => candidate.id === member.worktreeId)
      : undefined
    return {
      member,
      repo,
      worktree,
      availability: getMemberAvailability(member, repo, worktrees, worktree)
    }
  })
}

export function summarizeMultiRepoWorkspace(
  views: readonly MultiRepoMemberView[],
  changedCountByMemberId: ReadonlyMap<string, number> = new Map()
): MultiRepoWorkspaceSummary {
  const summary: MultiRepoWorkspaceSummary = {
    total: views.length,
    creating: 0,
    queued: 0,
    ready: 0,
    failed: 0,
    interrupted: 0,
    missing: 0,
    remaining: 0,
    changed: 0,
    withChanges: 0
  }
  for (const view of views) {
    summary[view.member.state] += 1
    if (view.availability !== 'ok') {
      summary.missing += 1
    }
    if (view.member.worktreeId) {
      summary.remaining += 1
    }
    const changed = changedCountByMemberId.get(view.member.memberId) ?? 0
    summary.changed += changed
    if (changed > 0) {
      summary.withChanges += 1
    }
  }
  return summary
}

/** Failed members block automatic agent start; interrupted ones need Retry too. */
export function multiRepoWorkspaceNeedsAttention(summary: MultiRepoWorkspaceSummary): boolean {
  return summary.failed + summary.interrupted > 0
}

export function findMultiRepoMemberByWorktreeId(
  workspaces: readonly FolderWorkspace[],
  worktreeId: string
): { workspace: FolderWorkspace; member: MultiRepoMember } | null {
  for (const workspace of workspaces) {
    const member = workspace.multiRepo?.members.find(
      (candidate) => candidate.worktreeId === worktreeId
    )
    if (member) {
      return { workspace, member }
    }
  }
  return null
}

/**
 * Host-scoped identities of worktrees that belong to a multi-repo workspace, for rows that must not
 * be dragged or reparented. Scoped so a same-id worktree on another host is not caught.
 */
export function collectMultiRepoMemberIdentities(
  workspaces: readonly FolderWorkspace[]
): ReadonlySet<HostScopedWorktreeKey> {
  const identities = new Set<HostScopedWorktreeKey>()
  for (const workspace of workspaces) {
    const hostId = resolveMultiRepoExecutionHostId(workspace)
    for (const member of workspace.multiRepo?.members ?? []) {
      if (member.worktreeId) {
        identities.add(composeWorktreeHostIdentity(hostId, member.worktreeId))
      }
    }
  }
  return identities
}

/** Derived lock: a worktree is locked iff a multi-repo member points at it. */
export function isMultiRepoLockedWorktree(
  workspaces: readonly FolderWorkspace[],
  worktreeId: string
): boolean {
  return findMultiRepoMemberByWorktreeId(workspaces, worktreeId) !== null
}
