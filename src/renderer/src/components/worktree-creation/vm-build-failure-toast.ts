import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { openPlansPage } from '@/components/billing/plans/plans-page-store'
import type { PendingWorktreeCreation } from '@/lib/workspace/creation/pending-worktree-creation'
import { classifyVmBuildFailure } from './vm-build-failure'
import { vmBuildFailureCopy } from './vm-build-failure-copy'
import { isOrcaCloudBuild } from './vm-build-steps'

/** The build sheet's card as a toast, for a VM build that failed while its sheet was off screen. */
export function showVmBuildFailureToast(entry: PendingWorktreeCreation, error: string): void {
  const cloud = isOrcaCloudBuild(entry)
  const failure = classifyVmBuildFailure({ entry, error, cloud })
  if (!failure) {
    return
  }
  // Unknown here; the card itself refines the copy for members once billing status loads.
  const { title, body } = vmBuildFailureCopy(failure, { cloud, canManageBilling: true }, translate)
  toast.error(title, {
    ...(body ? { description: body } : {}),
    ...(failure.kind === 'plan'
      ? {
          action: {
            label: translate('auto.lib.orcaCloudSession.seePlans', 'See plans'),
            onClick: () => openPlansPage('sandbox')
          }
        }
      : {})
  })
}
