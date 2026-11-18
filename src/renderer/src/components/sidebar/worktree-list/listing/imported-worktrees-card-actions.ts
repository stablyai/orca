import type { RepoSlice } from '@/store/repos/repo-state'
import { mergeExternalWorktreeInboxPaths } from '../../../../../../shared/worktree/visibility/external-worktree-inbox'
import { translate } from '@/i18n/i18n'

export type ImportedWorktreeCardActionState = {
  pending: boolean
  error: string | null
  forceVisible?: boolean
}

type ImportedWorktreeCardActionDeps = {
  projectId: string
  forceVisible?: boolean
  setCardState: (projectId: string, state: ImportedWorktreeCardActionState | null) => void
  updateRepo: RepoSlice['updateRepo']
  hiddenWorktreePaths?: readonly string[]
  fetchWorktrees: (
    projectId: string,
    options?: { requireAuthoritative?: boolean }
  ) => Promise<boolean>
}

export function getImportedWorktreesShowError(): string {
  return translate(
    'auto.components.sidebar.importedWorktreesCardActions.showError',
    'Could not show discovered worktrees. Try again.'
  )
}

export function getImportedWorktreesKeepHiddenError(): string {
  return translate(
    'auto.components.sidebar.importedWorktreesCardActions.keepHiddenError',
    'Could not keep discovered worktrees hidden. Try again.'
  )
}

export async function showImportedWorktreesCard(
  args: ImportedWorktreeCardActionDeps
): Promise<void> {
  const forceVisible = args.forceVisible === true
  // Preserve rollback-failure retry state so the visible error/action surface does not disappear.
  args.setCardState(args.projectId, {
    pending: true,
    error: null,
    ...(forceVisible ? { forceVisible: true } : {})
  })
  const updated = await args.updateRepo(args.projectId, { externalWorktreeVisibility: 'show' })
  if (!updated) {
    args.setCardState(args.projectId, {
      pending: false,
      error: getImportedWorktreesShowError(),
      ...(forceVisible ? { forceVisible: true } : {})
    })
    return
  }
  const refreshed = await args.fetchWorktrees(args.projectId, { requireAuthoritative: true })
  if (!refreshed) {
    const rolledBack = await args.updateRepo(args.projectId, { externalWorktreeVisibility: 'hide' })
    args.setCardState(args.projectId, {
      pending: false,
      error: getImportedWorktreesShowError(),
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
  const updated = await args.updateRepo(args.projectId, (latestRepo) => ({
    externalWorktreeVisibilityPromptDismissedAt:
      latestRepo.externalWorktreeVisibilityPromptDismissedAt ?? Date.now(),
    ...(args.hiddenWorktreePaths && args.hiddenWorktreePaths.length > 0
      ? {
          externalWorktreeInboxBaselinePaths: mergeExternalWorktreeInboxPaths(
            latestRepo.externalWorktreeInboxBaselinePaths,
            args.hiddenWorktreePaths
          )
        }
      : {})
  }))
  if (!updated) {
    args.setCardState(args.projectId, {
      pending: false,
      error: getImportedWorktreesKeepHiddenError()
    })
    return
  }
  args.setCardState(args.projectId, null)
}
