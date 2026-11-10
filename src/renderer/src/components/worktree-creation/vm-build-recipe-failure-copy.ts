import type { Translate } from '@/i18n/use-translate'

/**
 * A user-authored recipe's failure in plain words. The raw error goes in the card's Details
 * disclosure, never in the summary, so a long stack trace can't crowd out the way forward.
 */
export function localRecipeFailureCopy(
  kind: 'provision' | 'create',
  t: Translate
): { title: string; body: string } {
  return kind === 'provision'
    ? {
        title: t(
          'auto.components.worktree.creation.VmBuildFailureCard.provisionTitleVm',
          'The VM recipe failed'
        ),
        body: t(
          'auto.components.worktree.creation.VmBuildFailureCard.provisionBodyVm',
          'Your VM recipe stopped with an error before the VM was ready.'
        )
      }
    : {
        title: t(
          'auto.components.worktree.creation.VmBuildFailureCard.createTitleVm',
          'Couldn’t create the workspace on the VM'
        ),
        body: t(
          'auto.components.worktree.creation.VmBuildFailureCard.createBodyVm',
          'The VM started, but creating the workspace on it stopped with an error.'
        )
      }
}
