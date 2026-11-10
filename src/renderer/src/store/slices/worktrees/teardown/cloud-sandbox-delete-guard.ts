import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { ephemeralVmCleanupErrorText, ephemeralVmErrorText } from '@/lib/ephemeral-vm-error-copy'
import type { EphemeralVmRuntimeRecord } from '../../../../../../shared/ephemeral-vm-runtimes'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { CLOUD_ASLEEP_DELETE_REFUSAL } from '../../../../../../shared/worktree/removal'
import type { RemoveWorktreeOptions } from './worktree-removal-options'
import type { WorktreeSliceGet } from '../listing/worktree-slice-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '../../../../../../shared/worktree/id'
import { ensureHooksConfirmed } from '@/lib/ensure-hooks-confirmed'

type Preflight = Awaited<
  ReturnType<NonNullable<typeof window.api.ephemeralVm.preflightCloudDelete>>
>

/** One Delete asks twice (archive-hook gate, then dispatch); a few seconds is the same answer. */
const PREFLIGHT_REUSE_MS = 10_000
const recent = new Map<string, { at: number; result: Promise<Preflight> }>()

function preflightCloudDelete(
  runtimeEnvironmentId: string,
  options: { consume?: boolean } = {}
): Promise<Preflight> | null {
  const preflight = window.api.ephemeralVm?.preflightCloudDelete
  if (!preflight) {
    return null
  }
  const cached = recent.get(runtimeEnvironmentId)
  if (options.consume) {
    // The dispatch is the last ask of this Delete; a later Delete asks again.
    recent.delete(runtimeEnvironmentId)
  }
  if (cached && Date.now() - cached.at < PREFLIGHT_REUSE_MS) {
    return cached.result
  }
  if (options.consume) {
    return preflight({ runtimeEnvironmentId })
  }
  const result = preflight({ runtimeEnvironmentId })
  recent.set(runtimeEnvironmentId, { at: Date.now(), result })
  void result.catch(() => recent.delete(runtimeEnvironmentId))
  return result
}

/**
 * True when Delete won't talk to this workspace's server: an Orca Cloud sandbox that is asleep or
 * already gone. Its archive hooks can't run, and asking the server would only wait out timeouts.
 */
export async function cloudSandboxSkipsServer(
  runtimeEnvironmentId: string | null | undefined
): Promise<boolean> {
  if (!runtimeEnvironmentId) {
    return false
  }
  const result = await preflightCloudDelete(runtimeEnvironmentId)?.catch(() => null)
  return result?.ok === true && (result.asleep === true || result.gone === true)
}

/**
 * forget-local touches no remote/archive hooks; otherwise read current trust so concurrent
 * same-repo deletes share one approval. An asleep Orca Cloud sandbox can't run archive hooks, and
 * asking it would only wait out request timeouts (W9 measured 31 s), so its archive is skipped.
 */
export async function shouldSkipArchiveHooks(
  get: WorktreeSliceGet,
  forgetLocalOnly: boolean,
  target: {
    worktreeId: string
    hostId: ExecutionHostId | undefined
    runtimeEnvironmentId: string | null | undefined
  }
): Promise<boolean> {
  if (forgetLocalOnly || (await cloudSandboxSkipsServer(target.runtimeEnvironmentId))) {
    return true
  }
  const answer = await ensureHooksConfirmed(
    get,
    getRepoIdFromWorktreeId(target.worktreeId),
    'archive',
    target.hostId,
    target.runtimeEnvironmentId ?? undefined
  )
  return answer === 'skip'
}

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
  const result = await preflightCloudDelete(args.target.environmentId, { consume: true })
  if (!result) {
    return args.options
  }
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
