import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { openPlansPage } from '@/components/billing/plans/plans-page-store'
import type { PendingWorktreeCreation } from '@/lib/workspace/creation/pending-worktree-creation'
import { classifyVmBuildFailure, type VmBuildFailure } from './vm-build-failure'
import { getLastBillingStatus } from '@/components/billing/billing-summary-store'
import { vmBuildFailureCopy } from './vm-build-failure-copy'
import { sandboxLimitFromBilling } from './vm-build-sandbox-limit'
import { isOrcaCloudBuild } from './vm-build-steps'
import { orcaCloudRepoName } from './vm-build-repo-actions'
import type { Repo } from '../../../../shared/repo-types'

/** The build sheet card's words for a failed VM build, for surfaces that show it off the sheet. */
export function vmBuildFailureSummary(
  entry: PendingWorktreeCreation,
  error: string,
  repos: readonly Repo[],
  t: Translate = translate
): { failure: VmBuildFailure; title: string; body: string | null } | null {
  const cloud = isOrcaCloudBuild(entry)
  const failure = classifyVmBuildFailure({ entry, error, cloud })
  if (!failure) {
    return null
  }
  const recipe = entry.request.ephemeralVmRecipe
  const repoName = orcaCloudRepoName(
    recipe ? repos.find((repo) => repo.id === recipe.sourceRepoId) : undefined
  )
  // Unknown here; the card itself refines the copy for members once billing status loads.
  const sandboxLimit = sandboxLimitFromBilling(getLastBillingStatus())
  return {
    failure,
    ...vmBuildFailureCopy(
      failure,
      {
        cloud,
        canManageBilling: true,
        repoName,
        sandboxLimit,
        // Same rule as the sheet: failed checks or a recorded runtime mean a sandbox is still up.
        sandboxKept: failure.kind === 'checks' || Boolean(entry.request.ephemeralVmRuntimeId)
      },
      t
    )
  }
}

/** The build sheet's card as a toast, for a VM build that failed while its sheet was off screen. */
export function showVmBuildFailureToast(
  entry: PendingWorktreeCreation,
  error: string,
  repos: readonly Repo[]
): void {
  const summary = vmBuildFailureSummary(entry, error, repos)
  if (!summary) {
    return
  }
  const { failure, title, body } = summary
  toast.error(title, {
    ...(body ? { description: body } : {}),
    ...(failure.kind === 'plan'
      ? {
          action: {
            label: translate('auto.components.billing.comparePlans', 'Compare plans'),
            onClick: () => openPlansPage('sandbox')
          }
        }
      : {})
  })
}
