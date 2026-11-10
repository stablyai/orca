import type { Translate } from '@/i18n/use-translate'
import type { OrcaBillingStatusResult } from '../../../../shared/orca-billing'
import type { VmBuildFailure } from './vm-build-failure'

/** The running-sandbox caps billing enforces: per member, and per team (per seat × seats). */
export type SandboxLimit = { perSeat: number; team: number }

/** Mirrors billing's checkStart limits; null until the plan has loaded. */
export function sandboxLimitFromBilling(
  status: OrcaBillingStatusResult | null
): SandboxLimit | null {
  if (status?.status !== 'ok') {
    return null
  }
  const perSeat = status.entitlement.offers?.team.concurrentSandboxesPerSeat
  if (!perSeat) {
    return null
  }
  return { perSeat, team: perSeat * Math.max(1, status.entitlement.seats) }
}

export type VmBuildFailureCopyContext = {
  cloud: boolean
  /** How the user knows the repository: its GitHub owner/name, else its name in Orca. */
  repoName: string
  /** False for team members who can't change billing; they are told to ask an owner or admin. */
  canManageBilling: boolean
  /** States the cap on the limit cards; omitted or null falls back to copy without numbers. */
  sandboxLimit?: SandboxLimit | null
}

/** The card's cause-specific title and one plain-language sentence on what to do next. */
export function vmBuildFailureCopy(
  failure: VmBuildFailure,
  { cloud, canManageBilling, repoName, sandboxLimit }: VmBuildFailureCopyContext,
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
              'auto.components.worktree.creation.VmBuildFailureCard.planBody2',
              'Cloud workspaces are part of the Team plan. Nothing was created, and you weren’t charged.'
            )
          : t(
              'auto.components.worktree.creation.VmBuildFailureCard.planBodyMember2',
              'Ask an owner or admin to choose a Team plan. Nothing was created, and you weren’t charged.'
            )
      }
    case 'hoursUsed':
      return {
        title: t(
          'auto.components.worktree.creation.VmBuildFailureCard.outOfHoursTitle',
          'Out of sandbox hours'
        ),
        body: canManageBilling
          ? t(
              'auto.components.worktree.creation.VmBuildFailureCard.outOfHoursBody',
              'Your team has used this month’s sandbox hours. Turn on overage to keep starting sandboxes. Nothing was created, and you weren’t charged.'
            )
          : t(
              'auto.components.worktree.creation.VmBuildFailureCard.outOfHoursBodyMember',
              'Your team has used this month’s sandbox hours. Ask an owner or admin to add hours. Nothing was created, and you weren’t charged.'
            )
      }
    case 'spendCap':
      return {
        title: t(
          'auto.components.worktree.creation.VmBuildFailureCard.spendCapReachedTitle',
          'Spend cap reached'
        ),
        body: canManageBilling
          ? t(
              'auto.components.worktree.creation.VmBuildFailureCard.spendCapReachedBody',
              'Your team has reached this month’s spend cap. Raise it to keep starting sandboxes. Nothing was created, and you weren’t charged.'
            )
          : t(
              'auto.components.worktree.creation.VmBuildFailureCard.spendCapReachedBodyMember',
              'Your team has reached this month’s spend cap. Ask an owner or admin to add hours. Nothing was created, and you weren’t charged.'
            )
      }
    case 'payment':
      return {
        title: t(
          'auto.components.worktree.creation.VmBuildFailureCard.paymentFailedTitle',
          'Payment failed'
        ),
        body: canManageBilling
          ? t(
              'auto.components.worktree.creation.VmBuildFailureCard.paymentFailedBody',
              'New sandboxes can’t start until the payment goes through. Nothing was created, and you weren’t charged.'
            )
          : t(
              'auto.components.worktree.creation.VmBuildFailureCard.paymentFailedBodyMember',
              'New sandboxes can’t start until the payment goes through. Ask an owner or admin to update the payment method. Nothing was created, and you weren’t charged.'
            )
      }
    case 'concurrency':
      return {
        title: t(
          'auto.components.worktree.creation.VmBuildFailureCard.teamLimitTitle',
          'You’re at your team’s limit of running sandboxes'
        ),
        body: sandboxLimit
          ? t(
              'auto.components.worktree.creation.VmBuildFailureCard.teamLimitBody',
              'Your team can run {{value0}} sandboxes at once ({{value1}} per seat). Put one to sleep or delete it, then try again. Nothing was created, and you weren’t charged.',
              { value0: String(sandboxLimit.team), value1: String(sandboxLimit.perSeat) }
            )
          : t(
              'auto.components.worktree.creation.VmBuildFailureCard.limitBody',
              'Put one to sleep or delete it, then try again. Nothing was created, and you weren’t charged.'
            )
      }
    case 'memberConcurrency':
      return {
        title: t(
          'auto.components.worktree.creation.VmBuildFailureCard.memberLimitTitle',
          'You’re at your limit of running sandboxes'
        ),
        body: sandboxLimit
          ? t(
              'auto.components.worktree.creation.VmBuildFailureCard.memberLimitBody2',
              'You can run {{value0}} sandboxes at once. Put one to sleep or delete it, then try again. Nothing was created, and you weren’t charged.',
              { value0: String(sandboxLimit.perSeat) }
            )
          : t(
              'auto.components.worktree.creation.VmBuildFailureCard.limitBody',
              'Put one to sleep or delete it, then try again. Nothing was created, and you weren’t charged.'
            )
      }
    case 'githubNotConnected':
      return {
        title: t(
          'auto.components.worktree.creation.VmBuildFailureCard.githubNotConnectedTitle',
          'GitHub isn’t connected for {{repo}}',
          { repo: repoName }
        ),
        body: t(
          'auto.components.worktree.creation.VmBuildFailureCard.githubNotConnectedBody',
          'Orca Cloud clones your code from GitHub and needs access to this repository first. Connect GitHub, then try again. Nothing was created, and you weren’t charged.'
        )
      }
    case 'noGithubRemote':
      return {
        title: t(
          'auto.components.worktree.creation.VmBuildFailureCard.noGithubRemoteTitle',
          '{{repo}} isn’t on GitHub',
          { repo: repoName }
        ),
        body: t(
          'auto.components.worktree.creation.VmBuildFailureCard.noGithubRemoteBody2',
          'Orca Cloud clones your code from GitHub, and this repository has no GitHub remote. Push it to GitHub, then try again. Nothing was created, and you weren’t charged.'
        )
      }
    case 'signIn':
      return {
        title: t(
          'auto.components.worktree.creation.VmBuildFailureCard.signInTitle',
          'Sign in to use Orca Cloud'
        ),
        body: t(
          'auto.components.worktree.creation.VmBuildFailureCard.signInBody3',
          'Cloud workspaces run on your Orca account. Sign in and Orca starts this one for you. Nothing was created, and you weren’t charged.'
        )
      }
    case 'unavailable':
      return {
        title: t(
          'auto.components.worktree.creation.VmBuildFailureCard.unavailableTitle',
          'Orca Cloud is unavailable right now'
        ),
        body: t(
          'auto.components.worktree.creation.VmBuildFailureCard.unavailableBody2',
          'The problem is on our side, not in your project. Nothing was created, and you weren’t charged. Try again in a moment.'
        )
      }
    case 'network':
      return {
        title: t(
          'auto.components.worktree.creation.VmBuildFailureCard.networkTitle',
          'Couldn’t reach Orca Cloud'
        ),
        body: t(
          'auto.components.worktree.creation.VmBuildFailureCard.networkBody3',
          'Check your internet connection, then try again. Nothing was created, and you weren’t charged.'
        )
      }
    case 'snapshotMissing':
      return {
        title: t(
          'auto.components.worktree.creation.VmBuildFailureCard.snapshotTitle',
          'This project’s saved environment is missing'
        ),
        body: t(
          'auto.components.worktree.creation.VmBuildFailureCard.snapshotBody3',
          'The sandbox starts from a saved copy of your environment, and that copy couldn’t be found. Nothing was created, and you weren’t charged. Try again, or contact support if it keeps happening.'
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
