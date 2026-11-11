import type { Translate } from '@/i18n/use-translate'
import type {
  OrcaBillingEntitlement,
  OrcaBillingOffers,
  OrcaBillingStatusResult
} from '../../../../shared/orca-billing'
import type { VmBuildFailure } from './vm-build-failure'
import { sandboxLimitBody } from './vm-build-limit-copy'
import { cloneFailedBody, repoOwner } from './vm-build-clone-failure-copy'
import { localRecipeFailureCopy } from './vm-build-recipe-failure-copy'

/** The running-sandbox caps billing enforces: per member, and per team (per seat × seats). */
export type SandboxLimit = { perSeat: number; team: number }

/** The billing fields the caps derive from (any OrcaBillingStatusResult fits). */
export type SandboxLimitBillingStatus =
  | {
      status: 'ok'
      entitlement: Pick<OrcaBillingEntitlement, 'seats'> & {
        offers: { team: Pick<OrcaBillingOffers['team'], 'concurrentSandboxesPerSeat'> } | null
      }
    }
  | { status: Exclude<OrcaBillingStatusResult['status'], 'ok'> }

/** Mirrors billing's checkStart limits; null until the plan has loaded. */
export function sandboxLimitFromBilling(
  status: SandboxLimitBillingStatus | null
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
  /** A sandbox still exists (and uses hours), so the card can't say nothing was created. */
  sandboxKept?: boolean
}

/** The card's cause-specific title and one plain-language sentence on what to do next. */
export function vmBuildFailureCopy(
  failure: VmBuildFailure,
  { cloud, canManageBilling, repoName, sandboxLimit, sandboxKept }: VmBuildFailureCopyContext,
  t: Translate
): { title: string; body: string | null } {
  switch (failure.kind) {
    case 'checks': {
      if (cloud) {
        // Orca Cloud stops only when the sandbox can't hold the workspace at all; warnings open it.
        return {
          title: t(
            'auto.components.worktree.creation.VmBuildFailureCard.cloudUnusableTitle',
            'This sandbox can’t open your workspace'
          ),
          body:
            failure.sandbox === 'deleted'
              ? t(
                  'auto.components.worktree.creation.VmBuildFailureCard.cloudUnusableDeletedBody',
                  'The sandbox was deleted. Start again to try a new one.'
                )
              : t(
                  'auto.components.worktree.creation.VmBuildFailureCard.cloudUnusableBody',
                  'Start again on a new sandbox, or delete this one.'
                )
        }
      }
      // Warnings ride along in the list but don't count as failures in the title.
      const count = failure.problems.filter((check) => check.status === 'fail').length
      return {
        title:
          count === 0
            ? t(
                'auto.components.worktree.creation.VmBuildFailureCard.checksAttentionTitleVm',
                'The VM is up, but some environment checks need attention'
              )
            : t(
                'auto.components.worktree.creation.VmBuildFailureCard.checksCountTitleVm',
                'The VM is up, but {{count}} environment checks failed',
                {
                  count,
                  defaultValue_one: 'The VM is up, but {{count}} environment check failed'
                }
              ),
        body: null
      }
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
              'auto.components.worktree.creation.VmBuildFailureCard.planBodyMember3',
              'Nothing was created, and you weren’t charged. Ask an owner or admin to choose a Team plan.'
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
              'auto.components.worktree.creation.VmBuildFailureCard.outOfHoursBody2',
              'Your team has used this month’s sandbox hours, so sandboxes can’t start or keep running. Nothing was created, and you weren’t charged. Turn on overage to start sandboxes again.'
            )
          : t(
              'auto.components.worktree.creation.VmBuildFailureCard.outOfHoursBodyMember3',
              'Your team has used this month’s sandbox hours, so sandboxes can’t start or keep running. Nothing was created, and you weren’t charged. Ask an owner or admin to add hours.'
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
              'auto.components.worktree.creation.VmBuildFailureCard.spendCapReachedBody2',
              'Your team has reached this month’s spend cap, so sandboxes can’t start or keep running. Nothing was created, and you weren’t charged. Raise the cap to start sandboxes again.'
            )
          : t(
              'auto.components.worktree.creation.VmBuildFailureCard.spendCapReachedBodyMember4',
              'Your team has reached this month’s spend cap, so sandboxes can’t start or keep running. Nothing was created, and you weren’t charged. Ask an owner or admin to raise the spend cap.'
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
              'auto.components.worktree.creation.VmBuildFailureCard.paymentFailedBodyMember2',
              'New sandboxes can’t start until the payment goes through. Nothing was created, and you weren’t charged. Ask an owner or admin to update the payment method.'
            )
      }
    case 'concurrency':
      return {
        title: t(
          'auto.components.worktree.creation.VmBuildFailureCard.teamLimitTitle',
          'You’re at your team’s limit of running sandboxes'
        ),
        body: sandboxLimitBody(t, 'team', sandboxLimit)
      }
    case 'memberConcurrency':
      return {
        title: t(
          'auto.components.worktree.creation.VmBuildFailureCard.memberLimitTitle',
          'You’re at your limit of running sandboxes'
        ),
        body: sandboxLimitBody(t, 'member', sandboxLimit)
      }
    case 'githubNotConnected':
      return {
        title: t(
          'auto.components.worktree.creation.VmBuildFailureCard.githubNotConnectedTitle',
          'GitHub isn’t connected for {{repo}}',
          { repo: repoName }
        ),
        body: t(
          'auto.components.worktree.creation.VmBuildFailureCard.githubNotConnectedBody2',
          'Orca Cloud clones your code from GitHub and needs access to this repository first. Install the Orca GitHub App on {{owner}}, then try again. Nothing was created, and you weren’t charged.',
          { owner: repoOwner(repoName) }
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
            body: sandboxKept
              ? t(
                  'auto.components.worktree.creation.VmBuildFailureCard.provisionBodyCloudKept',
                  'Something went wrong while starting the sandbox. Try again, or delete the sandbox to stop using sandbox hours.'
                )
              : t(
                  'auto.components.worktree.creation.VmBuildFailureCard.provisionBodyCloud2',
                  'Something went wrong while starting the sandbox. Nothing was created, and you weren’t charged.'
                )
          }
        : localRecipeFailureCopy('provision', t)
    case 'cloneFailed':
      return {
        title: t(
          'auto.components.worktree.creation.VmBuildFailureCard.cloneFailedTitle',
          'Couldn’t clone {{repo}}',
          { repo: repoName }
        ),
        body: cloneFailedBody(failure.reason, t)
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
        : localRecipeFailureCopy('create', t)
  }
}
