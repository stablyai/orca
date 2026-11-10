import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { ephemeralVmCleanupErrorText, ephemeralVmErrorText } from '@/lib/ephemeral-vm-error-copy'
import type { EphemeralVmRuntimeRecord } from '../../../../../../shared/ephemeral-vm-runtimes'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { CLOUD_ASLEEP_DELETE_REFUSAL } from '../../../../../../shared/worktree/removal'
import type { RemoveWorktreeOptions } from './worktree-removal-options'

/**
 * Orca Cloud: the row goes only once its sandbox is reachable for the destroy that follows.
 * - An asleep sandbox has no server to remove its checkout from. The destroy takes the disk, so
 *   the row is forgotten locally instead of waking it. Without a server Orca can't check the
 *   checkout for unsaved work, so that needs Force delete.
 * - A sandbox Orca Cloud already destroyed has nothing left to protect.
 */
export async function prepareCloudSandboxDelete(args: {
  force: boolean | undefined
  options: RemoveWorktreeOptions | undefined
  target: RuntimeClientTarget
  /** Ownership/approval checks that must pass right before a destructive call. */
  assertBeforeDispatch: () => void
}): Promise<RemoveWorktreeOptions | undefined> {
  if (args.options?.mode === 'forget-local' || args.target.kind !== 'environment') {
    return args.options
  }
  const preflight = window.api.ephemeralVm?.preflightCloudDelete
  if (!preflight) {
    return args.options
  }
  const result = await preflight({ runtimeEnvironmentId: args.target.environmentId })
  if (!result.ok) {
    throw new Error(ephemeralVmErrorText(result))
  }
  if (!result.asleep && !result.gone) {
    return args.options
  }
  if (result.asleep && !args.force) {
    throw new Error(CLOUD_ASLEEP_DELETE_REFUSAL)
  }
  // forget-local skips the transport's own pre-send checks, so run them here.
  args.assertBeforeDispatch()
  return { ...args.options, mode: 'forget-local' }
}

function retryDestroy(runtimeId: string): void {
  void window.api.ephemeralVm
    .cleanup({ runtimeId })
    .then(reportCloudSandboxDestroyFailure)
    .catch((error: unknown) => reportCloudSandboxDestroyError(runtimeId, error))
}

function showDestroyFailure(runtimeId: string, description: string | undefined): void {
  toast.error(
    translate('auto.store.slices.worktrees.cloudDeleteFailedTitle', 'Couldn’t delete the sandbox'),
    {
      description,
      duration: Infinity,
      action: {
        label: translate('auto.store.slices.worktrees.cloudDeleteTryAgain', 'Try again'),
        onClick: () => retryDestroy(runtimeId)
      }
    }
  )
}

/**
 * The row is already gone when a sandbox destroy fails after Delete; never let that pass silently,
 * because the sandbox may still be running and billing. Offers a retry.
 */
export function reportCloudSandboxDestroyFailure(runtime: EphemeralVmRuntimeRecord): void {
  if (runtime.recipe?.provider !== 'orca-cloud' || runtime.status !== 'cleanup_failed') {
    return
  }
  showDestroyFailure(runtime.id, ephemeralVmCleanupErrorText(runtime) ?? undefined)
}

/** The destroy call itself threw (main error, unknown runtime): still a possibly running sandbox. */
export function reportCloudSandboxDestroyError(
  runtimeId: string,
  error: unknown,
  runtime?: Pick<EphemeralVmRuntimeRecord, 'recipe'>
): void {
  if (runtime && runtime.recipe?.provider !== 'orca-cloud') {
    return
  }
  showDestroyFailure(runtimeId, error instanceof Error ? error.message : String(error))
}
