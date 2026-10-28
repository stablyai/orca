import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { MultiRepoMemberFailureCode } from '../../../../shared/multi-repo-workspace'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import type { GitStatusEntry } from '../../../../shared/git-status-types'
import {
  deriveMultiRepoMemberViews,
  summarizeMultiRepoWorkspace,
  type MultiRepoWorkspaceSummary
} from '@/store/slices/multi-repo-workspace/multi-repo-workspace-selectors'

/** Failures after which "Remove from workspace" joins Retry (UX section 4). */
export const REMOVE_AFTER_FAILED_ATTEMPTS = 2

export type RootPanelRowStatus =
  | { kind: 'queued' }
  | { kind: 'creating' }
  | { kind: 'ready'; changedCount: number | null }
  | { kind: 'failed'; code: MultiRepoMemberFailureCode; detail: string }
  | { kind: 'interrupted' }
  | { kind: 'missing' }
  | { kind: 'project_removed' }

export type RootPanelRow = {
  memberId: string
  label: string
  branchName: string
  status: RootPanelRowStatus
  /** Workspace key to open; set only for rows that navigate somewhere. */
  openKey: string | null
  canRetry: boolean
  canRemove: boolean
}

export type RootPanelModel = {
  rootKey: string
  summary: MultiRepoWorkspaceSummary
  rows: RootPanelRow[]
  /** Labels of members that are not created yet, for the "only holds the ready repos" note. */
  notCreatedLabels: string[]
  retryAllCount: number
}

type RootPanelInput = {
  folderWorkspace: FolderWorkspace
  repos: readonly Repo[]
  worktreesByRepo: Readonly<Record<string, readonly Worktree[] | undefined>>
  gitStatusByWorktree: Readonly<Record<string, readonly GitStatusEntry[] | undefined>>
}

export function buildRootPanelModel({
  folderWorkspace,
  repos,
  worktreesByRepo,
  gitStatusByWorktree
}: RootPanelInput): RootPanelModel | null {
  if (!folderWorkspace.multiRepo) {
    return null
  }
  const views = deriveMultiRepoMemberViews(folderWorkspace, repos, worktreesByRepo)
  const changedByMember = new Map<string, number>()
  for (const { member } of views) {
    const status = member.worktreeId ? gitStatusByWorktree[member.worktreeId] : undefined
    if (status) {
      changedByMember.set(member.memberId, status.length)
    }
  }
  const rows = views.map<RootPanelRow>(({ member, repo, availability }) => {
    const label = repo?.displayName ?? member.dirName
    const base = {
      memberId: member.memberId,
      label,
      branchName: member.branchName
    }
    if (availability === 'project_removed') {
      return {
        ...base,
        status: { kind: 'project_removed' },
        openKey: null,
        canRetry: false,
        canRemove: true
      }
    }
    if (availability === 'missing') {
      return {
        ...base,
        status: { kind: 'missing' },
        openKey: null,
        canRetry: false,
        canRemove: true
      }
    }
    switch (member.state) {
      case 'queued':
        return {
          ...base,
          status: { kind: 'queued' },
          openKey: null,
          canRetry: false,
          canRemove: false
        }
      case 'creating':
        return {
          ...base,
          status: { kind: 'creating' },
          openKey: null,
          canRetry: false,
          canRemove: false
        }
      case 'interrupted':
        return {
          ...base,
          status: { kind: 'interrupted' },
          openKey: null,
          canRetry: true,
          canRemove: false
        }
      case 'failed':
        return {
          ...base,
          status: {
            kind: 'failed',
            code: member.failure?.code ?? 'unknown',
            detail: member.failure?.message ?? ''
          },
          openKey: null,
          canRetry: true,
          canRemove: member.attempts >= REMOVE_AFTER_FAILED_ATTEMPTS
        }
      case 'ready':
        return {
          ...base,
          status: { kind: 'ready', changedCount: changedByMember.get(member.memberId) ?? null },
          openKey: member.worktreeId ?? null,
          canRetry: false,
          canRemove: false
        }
    }
  })
  const summary = summarizeMultiRepoWorkspace(views, changedByMember)
  return {
    rootKey: folderWorkspaceKey(folderWorkspace.id),
    summary,
    rows,
    notCreatedLabels: rows
      .filter((row) => row.status.kind === 'failed' || row.status.kind === 'interrupted')
      .map((row) => row.label),
    retryAllCount: rows.filter((row) => row.canRetry).length
  }
}
