import type { Repo } from '../../../../shared/types'

export type ImportedWorktreeCardActionState = {
  pending: boolean
  error: string | null
  forceVisible?: boolean
}

type ImportedWorktreeCardActionDeps = {
  projectId: string
  forceVisible?: boolean
  setCardState: (projectId: string, state: ImportedWorktreeCardActionState | null) => void
  updateRepo: (
    projectId: string,
    updates: Partial<
      Pick<Repo, 'externalWorktreeVisibility' | 'externalWorktreeVisibilityPromptDismissedAt'>
    >
  ) => Promise<boolean>
  fetchWorktrees: (
    projectId: string,
    options?: { requireAuthoritative?: boolean }
  ) => Promise<boolean>
}

export const IMPORTED_WORKTREES_SHOW_ERROR = 'Could not show imported worktrees. Try again.'
export const IMPORTED_WORKTREES_KEEP_HIDDEN_ERROR =
  'Could not keep imported worktrees hidden. Try again.'

export async function showImportedWorktreesCard(
  args: ImportedWorktreeCardActionDeps
): Promise<void> {
  const forceVisible = args.forceVisible === true
  args.setCardState(args.projectId, {
    pending: true,
    error: null,
    forceVisible: true
  })
  const updated = await args.updateRepo(args.projectId, { externalWorktreeVisibility: 'show' })
  if (!updated) {
    args.setCardState(args.projectId, {
      pending: false,
      error: IMPORTED_WORKTREES_SHOW_ERROR,
      ...(forceVisible ? { forceVisible: true } : {})
    })
    return
  }
  const refreshed = await args.fetchWorktrees(args.projectId, { requireAuthoritative: true })
  if (!refreshed) {
    const rolledBack = await args.updateRepo(args.projectId, { externalWorktreeVisibility: 'hide' })
    args.setCardState(args.projectId, {
      pending: false,
      error: IMPORTED_WORKTREES_SHOW_ERROR,
      ...(rolledBack ? {} : { forceVisible: true })
    })
    return
  }
  args.setCardState(args.projectId, null)
}

export async function keepImportedWorktreesHiddenCard(
  args: Omit<ImportedWorktreeCardActionDeps, 'fetchWorktrees'>
): Promise<void> {
  args.setCardState(args.projectId, { pending: true, error: null })
  const updated = await args.updateRepo(args.projectId, {
    externalWorktreeVisibilityPromptDismissedAt: Date.now()
  })
  if (!updated) {
    args.setCardState(args.projectId, {
      pending: false,
      error: IMPORTED_WORKTREES_KEEP_HIDDEN_ERROR
    })
    return
  }
  args.setCardState(args.projectId, null)
}
