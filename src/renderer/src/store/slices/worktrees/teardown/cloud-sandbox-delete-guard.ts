import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { ephemeralVmCleanupErrorText, ephemeralVmErrorText } from '@/lib/ephemeral-vm-error-copy'
import type { EphemeralVmRuntimeRecord } from '../../../../../../shared/ephemeral-vm-runtimes'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import type { RemoveWorktreeOptions } from './worktree-removal-options'

/**
 * Orca Cloud: the row goes only once its sandbox is reachable for the destroy that follows. An
 * asleep sandbox has no server to remove its checkout from; the destroy takes the disk, so the
 * row is forgotten locally instead of waking the sandbox.
 */
export async function prepareCloudSandboxDelete(
  policy: { forgetLocalOnly: boolean; options: RemoveWorktreeOptions | undefined },
  target: RuntimeClientTarget
): Promise<{ dispatchOptions: RemoveWorktreeOptions | undefined }> {
  const cloudSandboxAsleep =
    !policy.forgetLocalOnly && target.kind === 'environment'
      ? await assertCloudSandboxDeletable(target.environmentId)
      : false
  return {
    dispatchOptions: cloudSandboxAsleep
      ? { ...policy.options, mode: 'forget-local' }
      : policy.options
  }
}

/**
 * Throws (so Delete keeps the row and shows the error) when Orca Cloud can't reach this
 * workspace's sandbox as the signed-in identity. Non-cloud environments pass straight through.
 * Returns true when the sandbox is asleep: its checkout goes with the destroy, no wake needed.
 */
export async function assertCloudSandboxDeletable(runtimeEnvironmentId: string): Promise<boolean> {
  const preflight = window.api.ephemeralVm?.preflightCloudDelete
  if (!preflight) {
    return false
  }
  const result = await preflight({ runtimeEnvironmentId })
  if (!result.ok) {
    throw new Error(ephemeralVmErrorText(result))
  }
  return result.asleep === true
}

/**
 * The row is already gone when a sandbox destroy fails after Delete; never let that pass silently,
 * because the sandbox may still be running and billing. Offers one retry.
 */
export function reportCloudSandboxDestroyFailure(runtime: EphemeralVmRuntimeRecord): void {
  if (runtime.recipe?.provider !== 'orca-cloud' || runtime.status !== 'cleanup_failed') {
    return
  }
  toast.error(
    translate('auto.store.slices.worktrees.cloudDeleteFailedTitle', 'Couldn’t delete the sandbox'),
    {
      description: ephemeralVmCleanupErrorText(runtime) ?? undefined,
      duration: Infinity,
      action: {
        label: translate('auto.store.slices.worktrees.cloudDeleteTryAgain', 'Try again'),
        onClick: () => {
          void window.api.ephemeralVm
            .cleanup({ runtimeId: runtime.id })
            .then(reportCloudSandboxDestroyFailure)
            .catch(() => undefined)
        }
      }
    }
  )
}
