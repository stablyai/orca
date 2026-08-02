import type { Repo } from '../../../../shared/types'
import { mergeExternalWorktreeInboxPaths } from '../../../../shared/external-worktree-inbox'
import { translate } from '@/i18n/i18n'

export type NewExternalWorktreesInboxActionState = {
  pending: boolean
  error: string | null
}

type RepoExternalWorktreeInboxUpdate = Partial<
  Pick<
    Repo,
    | 'externalWorktreeInboxBaselinePaths'
    | 'importedExternalWorktreePaths'
    | 'externalWorktreeDiscoverySuppressedAt'
  >
>

type NewExternalWorktreesInboxActionDeps = {
  projectId: string
  repo: Pick<Repo, 'externalWorktreeInboxBaselinePaths' | 'importedExternalWorktreePaths'>
  worktreePaths: readonly string[]
  setInboxState: (projectId: string, state: NewExternalWorktreesInboxActionState | null) => void
  updateRepo: (projectId: string, updates: RepoExternalWorktreeInboxUpdate) => Promise<boolean>
  fetchWorktrees: (
    projectId: string,
    options?: { requireAuthoritative?: boolean }
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

function rollbackPathList(paths: readonly string[] | undefined): string[] {
  return [...(paths ?? [])]
}

async function refreshAfterRepoInboxUpdate(
  args: NewExternalWorktreesInboxActionDeps,
  updates: RepoExternalWorktreeInboxUpdate,
  rollbackUpdates: RepoExternalWorktreeInboxUpdate
): Promise<boolean> {
  args.setInboxState(args.projectId, { pending: true, error: null })
  const updated = await args.updateRepo(args.projectId, updates)
  if (!updated) {
    args.setInboxState(args.projectId, {
      pending: false,
      error: newExternalWorktreeInboxImportError()
    })
    return false
  }
  const refreshed = await args.fetchWorktrees(args.projectId, { requireAuthoritative: true })
  if (!refreshed) {
    await args.updateRepo(args.projectId, rollbackUpdates)
    args.setInboxState(args.projectId, {
      pending: false,
      error: newExternalWorktreeInboxImportError()
    })
    return false
  }
  args.setInboxState(args.projectId, null)
  return true
}

export async function keepNewExternalWorktreeInboxHidden(
  args: NewExternalWorktreesInboxActionDeps
): Promise<void> {
  args.setInboxState(args.projectId, { pending: true, error: null })
  const baseline = mergeExternalWorktreeInboxPaths(
    args.repo.externalWorktreeInboxBaselinePaths,
    args.worktreePaths
  )
  const updated = await args.updateRepo(args.projectId, {
    externalWorktreeInboxBaselinePaths: baseline
  })
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
  const importedExternalWorktreePaths = mergeExternalWorktreeInboxPaths(
    args.repo.importedExternalWorktreePaths,
    args.worktreePaths
  )
  const externalWorktreeInboxBaselinePaths = mergeExternalWorktreeInboxPaths(
    args.repo.externalWorktreeInboxBaselinePaths,
    args.worktreePaths
  )
  await refreshAfterRepoInboxUpdate(
    args,
    { importedExternalWorktreePaths, externalWorktreeInboxBaselinePaths },
    {
      importedExternalWorktreePaths: rollbackPathList(args.repo.importedExternalWorktreePaths),
      externalWorktreeInboxBaselinePaths: rollbackPathList(
        args.repo.externalWorktreeInboxBaselinePaths
      )
    }
  )
}

export async function suppressNewExternalWorktreeInbox(
  args: Omit<NewExternalWorktreesInboxActionDeps, 'fetchWorktrees'>
): Promise<boolean> {
  args.setInboxState(args.projectId, { pending: true, error: null })
  const externalWorktreeInboxBaselinePaths = mergeExternalWorktreeInboxPaths(
    args.repo.externalWorktreeInboxBaselinePaths,
    args.worktreePaths
  )
  const updated = await args.updateRepo(args.projectId, {
    externalWorktreeDiscoverySuppressedAt: Date.now(),
    externalWorktreeInboxBaselinePaths
  })
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
