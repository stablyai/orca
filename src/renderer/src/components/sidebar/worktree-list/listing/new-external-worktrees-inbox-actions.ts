import type { RepoSlice } from '@/store/repos/repo-state'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import { mergeExternalWorktreeInboxPaths } from '../../../../../../shared/worktree/visibility/external-worktree-inbox'
import { translate } from '@/i18n/i18n'

export type NewExternalWorktreesInboxActionState = {
  pending: boolean
  error: string | null
}

type NewExternalWorktreesInboxActionDeps = {
  projectId: string
  repo: Pick<Repo, 'externalWorktreeInboxBaselinePaths' | 'importedExternalWorktreePaths'>
  worktreePaths: readonly string[]
  setInboxState: (projectId: string, state: NewExternalWorktreesInboxActionState | null) => void
  updateRepo: RepoSlice['updateRepo']
  fetchWorktrees: (
    projectId: string,
    options?: { requireAuthoritative?: boolean; forceFresh?: boolean }
  ) => Promise<boolean>
}

function newExternalWorktreeInboxKeepHiddenError(): string {
  return translate(
    'auto.components.sidebar.newExternalWorktreesInboxActions.a11c2f6d89',
    'Could not keep external worktrees hidden. Try again.'
  )
}

function newExternalWorktreeInboxImportError(): string {
  return translate(
    'auto.components.sidebar.newExternalWorktreesInboxActions.b7e4d1a062',
    'Could not import external worktrees. Try again.'
  )
}

function newExternalWorktreeInboxSuppressError(): string {
  return translate(
    'auto.components.sidebar.newExternalWorktreesInboxActions.c94f0b3a15',
    'Could not hide external worktrees permanently. Try again.'
  )
}

export async function keepNewExternalWorktreeInboxHidden(
  args: NewExternalWorktreesInboxActionDeps
): Promise<void> {
  args.setInboxState(args.projectId, { pending: true, error: null })
  const updated = await args.updateRepo(args.projectId, (latestRepo) => ({
    externalWorktreeInboxBaselinePaths: mergeExternalWorktreeInboxPaths(
      latestRepo.externalWorktreeInboxBaselinePaths,
      args.worktreePaths
    )
  }))
  if (!updated) {
    args.setInboxState(args.projectId, {
      pending: false,
      error: newExternalWorktreeInboxKeepHiddenError()
    })
    return
  }
  args.setInboxState(args.projectId, null)
}

export async function importNewExternalWorktreeInboxPaths(
  args: NewExternalWorktreesInboxActionDeps
): Promise<void> {
  args.setInboxState(args.projectId, { pending: true, error: null })
  const updated = await args.updateRepo(args.projectId, (latestRepo) => ({
    importedExternalWorktreePaths: mergeExternalWorktreeInboxPaths(
      latestRepo.importedExternalWorktreePaths,
      args.worktreePaths
    ),
    externalWorktreeInboxBaselinePaths: mergeExternalWorktreeInboxPaths(
      latestRepo.externalWorktreeInboxBaselinePaths,
      args.worktreePaths
    )
  }))
  const refreshed =
    updated &&
    (await args.fetchWorktrees(args.projectId, {
      requireAuthoritative: true,
      forceFresh: true
    }))
  args.setInboxState(
    args.projectId,
    refreshed
      ? null
      : {
          pending: false,
          error: newExternalWorktreeInboxImportError()
        }
  )
}

export async function suppressNewExternalWorktreeInbox(
  args: Omit<NewExternalWorktreesInboxActionDeps, 'fetchWorktrees'>
): Promise<boolean> {
  args.setInboxState(args.projectId, { pending: true, error: null })
  const updated = await args.updateRepo(args.projectId, (latestRepo) => ({
    externalWorktreeDiscoverySuppressedAt: Date.now(),
    externalWorktreeInboxBaselinePaths: mergeExternalWorktreeInboxPaths(
      latestRepo.externalWorktreeInboxBaselinePaths,
      args.worktreePaths
    )
  }))
  if (!updated) {
    args.setInboxState(args.projectId, {
      pending: false,
      error: newExternalWorktreeInboxSuppressError()
    })
    return false
  }
  args.setInboxState(args.projectId, null)
  return true
}
