import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../shared/worktree/types'
import { getWorktreeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import {
  resolveWorktreeBranchLabel,
  resolveWorktreeDisplayName
} from '@/lib/worktree-default-display-name'
import { getFolderWorkspaceExecutionHostIdForRows } from './worktree-list/listing/host-filtering'
import {
  isAutomationGeneratedWorkspace,
  isCliCreatedWorkspace,
  isDetachedHeadWorkspace
} from './visible-worktree-kinds'
import {
  workspaceMatchesFilterQuery,
  type WorkspaceFilterSubject
} from './workspace-filter-query-match'
import type { SidebarFilterQueryEvaluation } from './sidebar-filter-query-evaluation'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'

export type WorkspaceFilterSubjectContext = {
  repoMap: ReadonlyMap<string, Repo>
  defaultHostId: ExecutionHostId
  hostLabelById: ReadonlyMap<string, string>
  statusLabelById: ReadonlyMap<string, string>
}

export function buildWorkspaceStatusLabelById(
  statuses: readonly WorkspaceStatusDefinition[]
): Map<string, string> {
  return new Map(statuses.map((status) => [status.id, status.label]))
}

function collectNumbers(values: readonly (number | null | undefined)[]): number[] {
  return values.filter((value): value is number => typeof value === 'number')
}

export function buildWorktreeFilterSubject(
  worktree: Worktree,
  isSleeping: boolean,
  context: WorkspaceFilterSubjectContext
): WorkspaceFilterSubject {
  const repo = context.repoMap.get(worktree.repoId)
  const hostId = getWorktreeExecutionHostId(worktree, repo, context.defaultHostId)
  const linked = worktree.linkedWorkItem
  return {
    kind: 'worktree',
    name: resolveWorktreeDisplayName(worktree),
    branch: resolveWorktreeBranchLabel(worktree),
    repoName: repo?.displayName ?? '',
    repoPath: repo?.path ?? '',
    hostId,
    hostLabel: context.hostLabelById.get(hostId) ?? '',
    path: worktree.path,
    statusId: worktree.workspaceStatus ?? '',
    statusLabel: context.statusLabelById.get(worktree.workspaceStatus ?? '') ?? '',
    comment: worktree.comment,
    prNumbers: collectNumbers([
      worktree.linkedPR,
      worktree.linkedGitLabMR,
      worktree.linkedBitbucketPR,
      worktree.linkedAzureDevOpsPR,
      worktree.linkedGiteaPR,
      linked && linked.type !== 'issue' ? linked.number : null
    ]),
    issueNumbers: collectNumbers([
      worktree.linkedIssue,
      worktree.linkedGitLabIssue,
      linked?.type === 'issue' ? linked.number : null
    ]),
    pinned: worktree.isPinned,
    main: worktree.isMainWorktree,
    sleeping: isSleeping,
    detached: isDetachedHeadWorkspace(worktree),
    cli: isCliCreatedWorkspace(worktree),
    automation: isAutomationGeneratedWorkspace(worktree),
    unread: worktree.isUnread
  }
}

export function buildFolderWorkspaceFilterSubject(
  folderWorkspace: FolderWorkspace,
  projectGroup: ProjectGroup | undefined,
  context: Pick<
    WorkspaceFilterSubjectContext,
    'defaultHostId' | 'hostLabelById' | 'statusLabelById'
  >
): WorkspaceFilterSubject {
  const hostId = getFolderWorkspaceExecutionHostIdForRows({
    folderWorkspace,
    projectGroup,
    defaultHostId: context.defaultHostId
  })
  const linked = folderWorkspace.linkedTask
  return {
    kind: 'folder',
    name: folderWorkspace.name,
    branch: '',
    repoName: projectGroup?.name ?? '',
    repoPath: projectGroup?.parentPath ?? '',
    hostId,
    hostLabel: context.hostLabelById.get(hostId) ?? '',
    path: folderWorkspace.folderPath,
    statusId: folderWorkspace.workspaceStatus ?? '',
    statusLabel: context.statusLabelById.get(folderWorkspace.workspaceStatus ?? '') ?? '',
    comment: folderWorkspace.comment,
    prNumbers: linked && linked.type !== 'issue' ? [linked.number] : [],
    issueNumbers: linked?.type === 'issue' ? [linked.number] : [],
    pinned: folderWorkspace.isPinned,
    main: false,
    // Why: folder workspaces have no terminal-activity sweep, so they read as active.
    sleeping: false,
    detached: false,
    cli: false,
    automation: false,
    unread: folderWorkspace.isUnread
  }
}

/** Keeps the worktrees the evaluated sidebar query accepts; sleeping is resolved per row by the caller. */
export function filterWorktreesBySidebarQuery(
  worktrees: readonly Worktree[],
  evaluation: SidebarFilterQueryEvaluation,
  context: Pick<WorkspaceFilterSubjectContext, 'repoMap' | 'defaultHostId'>,
  isSleeping: (worktree: Worktree) => boolean
): Worktree[] {
  const subjectContext: WorkspaceFilterSubjectContext = {
    repoMap: context.repoMap,
    defaultHostId: context.defaultHostId,
    hostLabelById: evaluation.hostLabelById,
    statusLabelById: evaluation.statusLabelById
  }
  return worktrees.filter((worktree) =>
    workspaceMatchesFilterQuery({
      parsed: evaluation.parsed,
      subject: buildWorktreeFilterSubject(worktree, isSleeping(worktree), subjectContext),
      rowKey: getWorktreeHostIdentity(worktree),
      verdicts: evaluation.verdicts
    })
  )
}
