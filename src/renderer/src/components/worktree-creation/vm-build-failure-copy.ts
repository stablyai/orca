import type { Translate } from '@/i18n/use-translate'
import type { VmBuildFailure } from './vm-build-failure'

export type VmBuildFailureCopyContext = {
  cloud: boolean
  /** False for team members who can't change billing; they are told to ask an owner or admin. */
  canManageBilling: boolean
}

/** The card's cause-specific title and one plain-language sentence on what to do next. */
export function vmBuildFailureCopy(
  failure: VmBuildFailure,
  { cloud, canManageBilling }: VmBuildFailureCopyContext,
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
        body: canManageBilling
          ? t(
              'auto.components.worktree.creation.VmBuildFailureCard.planBody',
              'Cloud workspaces are part of the Team plan. Nothing was created, and you weren’t charged.'
            )
          : t(
              'auto.components.worktree.creation.VmBuildFailureCard.planBodyMember',
              'Ask an owner or admin to choose a Team plan. Nothing was created, and you weren’t charged.'
            )
      }
    case 'hoursUsed':
      return {
        title: t(
          'auto.components.worktree.creation.VmBuildFailureCard.hoursUsedTitle',
          'You’ve used this month’s included sandbox hours'
        ),
        body: canManageBilling
          ? t(
              'auto.components.worktree.creation.VmBuildFailureCard.hoursUsedBody',
              'Turn on overage in Plan & billing to keep starting sandboxes. Nothing was created.'
            )
          : t(
              'auto.components.worktree.creation.VmBuildFailureCard.hoursUsedBodyMember',
              'Ask an owner or admin to turn on overage. Nothing was created.'
            )
      }
    case 'spendCap':
      return {
        title: t(
          'auto.components.worktree.creation.VmBuildFailureCard.spendCapTitle',
          'You’ve reached this month’s spend cap'
        ),
        body: canManageBilling
          ? t(
              'auto.components.worktree.creation.VmBuildFailureCard.spendCapBody',
              'Raise the monthly spend cap in Plan & billing to keep starting sandboxes. Nothing was created.'
            )
          : t(
              'auto.components.worktree.creation.VmBuildFailureCard.spendCapBodyMember',
              'Ask an owner or admin to raise the monthly spend cap. Nothing was created.'
            )
      }
    case 'payment':
      return {
        title: t(
          'auto.components.worktree.creation.VmBuildFailureCard.paymentTitle',
          'Your Orca payment needs attention'
        ),
        body: canManageBilling
          ? t(
              'auto.components.worktree.creation.VmBuildFailureCard.paymentBody',
              'Update your payment method to start cloud workspaces again. Nothing was created.'
            )
          : t(
              'auto.components.worktree.creation.VmBuildFailureCard.paymentBodyMember',
              'Ask an owner or admin to update the payment method. Nothing was created.'
            )
      }
    case 'concurrency':
      return {
        title: t(
          'auto.components.worktree.creation.VmBuildFailureCard.concurrencyTitle',
          'Your team is running as many cloud workspaces as its plan allows'
        ),
        body: t(
          'auto.components.worktree.creation.VmBuildFailureCard.concurrencyBody',
          'Put a running cloud workspace to sleep or delete it, then try again. Nothing was created.'
        )
      }
    case 'memberConcurrency':
      return {
        title: t(
          'auto.components.worktree.creation.VmBuildFailureCard.memberConcurrencyTitle',
          'You’re running as many cloud workspaces as you can at once'
        ),
        body: t(
          'auto.components.worktree.creation.VmBuildFailureCard.memberConcurrencyBody',
          'Put one of yours to sleep or delete it, then try again. Nothing was created.'
        )
      }
    case 'githubNotConnected':
      return {
        title: t(
          'auto.components.worktree.creation.VmBuildFailureCard.githubTitle',
          'Connect GitHub to use this repository'
        ),
        body: t(
          'auto.components.worktree.creation.VmBuildFailureCard.githubBody',
          'Orca Cloud needs access to GitHub to clone this private repository. Connect GitHub to your Orca account, then try again. Nothing was created.'
        )
      }
    case 'signIn':
      return {
        title: t(
          'auto.components.worktree.creation.VmBuildFailureCard.signInTitle',
          'Sign in to use Orca Cloud'
        ),
        body: t(
          'auto.components.worktree.creation.VmBuildFailureCard.signInBody2',
          'Cloud workspaces run on your Orca account. Sign in and Orca starts this one for you. Nothing was created.'
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
          'auto.components.worktree.creation.VmBuildFailureCard.networkBody2',
          'Check your internet connection, then try again. Nothing was created.'
        )
      }
    case 'snapshotMissing':
      return {
        title: t(
          'auto.components.worktree.creation.VmBuildFailureCard.snapshotTitle',
          'This project’s saved environment is missing'
        ),
        body: t(
          'auto.components.worktree.creation.VmBuildFailureCard.snapshotBody2',
          'The sandbox starts from a saved copy of your environment, and that copy couldn’t be found. Nothing was created. Try again, or contact support if it keeps happening.'
        )
      }
    case 'provision':
      return cloud
        ? {
            title: t(
              'auto.components.worktree.creation.VmBuildFailureCard.provisionTitleCloud',
              'The sandbox didn’t start'
            ),
            body: t(
              'auto.components.worktree.creation.VmBuildFailureCard.provisionBodyCloud',
              'Something went wrong while starting the sandbox. Try again, or open the logs for details.'
            )
          }
        : {
            title: t(
              'auto.components.worktree.creation.VmBuildFailureCard.provisionTitleVm',
              'The VM recipe failed'
            ),
            body: failure.error
          }
    case 'create':
      return cloud
        ? {
            title: t(
              'auto.components.worktree.creation.VmBuildFailureCard.createTitleCloud',
              'Couldn’t open the workspace on the sandbox'
            ),
            body: t(
              'auto.components.worktree.creation.VmBuildFailureCard.createBodyCloud2',
              'The sandbox started, but Orca couldn’t open the workspace on it. Try again, or open the logs for details.'
            )
          }
        : {
            title: t(
              'auto.components.worktree.creation.VmBuildFailureCard.createTitleVm',
              'Couldn’t create the workspace on the VM'
            ),
            body: failure.error
          }
  }
}
