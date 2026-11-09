import type { Translate } from '@/i18n/use-translate'
import type { VmBuildFailure } from './vm-build-failure'

/** The card's title and one plain-language sentence on what happened and what to do. */
export function vmBuildFailureCopy(
  failure: VmBuildFailure,
  cloud: boolean,
  t: Translate
): { title: string; body: string | null } {
  switch (failure.kind) {
    case 'checks':
      return {
        title: cloud
          ? t(
              'auto.components.worktree.creation.VmBuildFailureCard.checksTitleCloud',
              'The sandbox is up, but its environment checks failed'
            )
          : t(
              'auto.components.worktree.creation.VmBuildSheet.checksFailed',
              'The VM is up, but its environment checks failed'
            ),
        body: cloud
          ? t(
              'auto.components.worktree.creation.VmBuildFailureCard.checksBodyCloud',
              'Open anyway to fix these inside the workspace, or retry the checks after changing your project.'
            )
          : null
      }
    case 'plan':
      return {
        title: t(
          'auto.components.worktree.creation.VmBuildFailureCard.planTitle',
          'Orca Cloud needs a Team plan'
        ),
        body: t(
          'auto.components.worktree.creation.VmBuildFailureCard.planBody',
          'Cloud workspaces are part of the Team plan. Nothing was created, and you weren’t charged.'
        )
      }
    case 'hoursUsed':
      return {
        title: t(
          'auto.components.worktree.creation.VmBuildFailureCard.hoursUsedTitle',
          'You’ve used this period’s sandbox hours'
        ),
        body: t(
          'auto.components.worktree.creation.VmBuildFailureCard.hoursUsedBody',
          'Raise your overage limit or wait for your hours to reset. Nothing was created.'
        )
      }
    case 'payment':
      return {
        title: t(
          'auto.components.worktree.creation.VmBuildFailureCard.paymentTitle',
          'Your Orca payment needs attention'
        ),
        body: t(
          'auto.components.worktree.creation.VmBuildFailureCard.paymentBody',
          'Update your payment method to start cloud workspaces again. Nothing was created.'
        )
      }
    case 'concurrency':
      return {
        title: t(
          'auto.components.worktree.creation.VmBuildFailureCard.concurrencyTitle',
          'All your cloud workspaces are in use'
        ),
        body: t(
          'auto.components.worktree.creation.VmBuildFailureCard.concurrencyBody',
          'You’ve reached your plan’s limit on running cloud workspaces. Put one to sleep or delete it from the sidebar, then try again.'
        )
      }
    case 'signIn':
      return {
        title: t(
          'auto.components.worktree.creation.VmBuildFailureCard.signInTitle',
          'Sign in to use Orca Cloud'
        ),
        body: t(
          'auto.components.worktree.creation.VmBuildFailureCard.signInBody',
          'Cloud workspaces run on your Orca account. Sign in and Orca starts this one for you.'
        )
      }
    case 'unavailable':
      return {
        title: t(
          'auto.components.worktree.creation.VmBuildFailureCard.unavailableTitle',
          'Orca Cloud is unavailable right now'
        ),
        body: t(
          'auto.components.worktree.creation.VmBuildFailureCard.unavailableBody',
          'The problem is on our side, not in your project. Nothing was created. Try again in a moment.'
        )
      }
    case 'network':
      return {
        title: t(
          'auto.components.worktree.creation.VmBuildFailureCard.networkTitle',
          'Couldn’t reach Orca Cloud'
        ),
        body: t(
          'auto.components.worktree.creation.VmBuildFailureCard.networkBody',
          'Check your internet connection, then try again.'
        )
      }
    case 'snapshotMissing':
      return {
        title: t(
          'auto.components.worktree.creation.VmBuildFailureCard.snapshotTitle',
          'This project’s saved environment is missing'
        ),
        body: t(
          'auto.components.worktree.creation.VmBuildFailureCard.snapshotBody',
          'The sandbox starts from a saved copy of your environment, and that copy couldn’t be found. Try again; if it keeps happening, contact support.'
        )
      }
    case 'provision':
      return {
        title: t(
          'auto.components.worktree.creation.VmBuildFailureCard.createFailedTitle',
          'Couldn’t create workspace'
        ),
        body: cloud
          ? t(
              'auto.components.worktree.creation.VmBuildFailureCard.provisionBodyCloud',
              'Something went wrong while starting the sandbox. Try again, or open the logs for details.'
            )
          : failure.error
      }
    case 'create':
      return {
        title: t(
          'auto.components.worktree.creation.VmBuildFailureCard.createFailedTitle',
          'Couldn’t create workspace'
        ),
        body: cloud
          ? t(
              'auto.components.worktree.creation.VmBuildFailureCard.createBodyCloud',
              'Your sandbox started, but Orca couldn’t open the workspace on it. Try again, or open the logs for details.'
            )
          : failure.error
      }
  }
}
