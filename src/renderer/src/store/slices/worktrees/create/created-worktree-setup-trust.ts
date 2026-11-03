import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AppState } from '@/store/types'
import { confirmCreatedWorktreeSetupContent } from '@/lib/ensure-hooks-confirmed'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { WORKTREE_RUN_APPROVED_SETUP_RUNTIME_CAPABILITY } from '../../../../../../shared/worktree-runtime-capabilities'
import type {
  CreateWorktreeResult,
  RunApprovedWorktreeSetupArgs,
  RunApprovedWorktreeSetupResult
} from '../../../../../../shared/worktree/create-types'

/** The host skipped setup because the created branch's commands differ; ask about the real ones. */
export function reviewSetupTrustMismatch(
  getState: () => AppState,
  repoId: string,
  hostId: ExecutionHostId | undefined,
  result: Pick<CreateWorktreeResult, 'setupTrustMismatch' | 'worktree'>,
  target: RuntimeClientTarget
): void {
  const mismatch = result.setupTrustMismatch
  if (!mismatch) {
    return
  }
  toast.warning(
    translate(
      'worktree.setupTrust.createdBranchSkipped',
      "Setup didn't run: this branch's orca.yaml setup commands differ from the ones you approved."
    )
  )
  void (async () => {
    const approval = await confirmCreatedWorktreeSetupContent(
      getState,
      repoId,
      mismatch.scriptContent,
      hostId
    )
    if (approval.decision !== 'run' || approval.approvedContentHash === undefined) {
      return
    }
    const outcome = await runApprovedWorktreeSetup(target, {
      worktreeId: result.worktree.id,
      approvedSetupHash: approval.approvedContentHash
    })
    showApprovedSetupOutcome(outcome)
  })().catch((error: unknown) => {
    console.error('Failed to run the approved workspace setup:', error)
    toast.error(translate('worktree.setupTrust.runFailed', 'Could not start setup.'))
  })
}

async function runApprovedWorktreeSetup(
  target: RuntimeClientTarget,
  args: RunApprovedWorktreeSetupArgs
): Promise<RunApprovedWorktreeSetupResult> {
  if (target.kind === 'environment') {
    const supported = await runtimeEnvironmentSupportsCapability(
      target.environmentId,
      WORKTREE_RUN_APPROVED_SETUP_RUNTIME_CAPABILITY
    ).catch(() => false)
    return supported
      ? callRuntimeRpc<RunApprovedWorktreeSetupResult>(target, 'worktree.runApprovedSetup', {
          worktree: toRuntimeWorktreeSelector(args.worktreeId),
          approvedSetupHash: args.approvedSetupHash
        })
      : { status: 'unsupported' }
  }
  const run = window.api.worktrees.runApprovedSetup
  return run ? run(args) : { status: 'unsupported' }
}

function showApprovedSetupOutcome(outcome: RunApprovedWorktreeSetupResult): void {
  if (outcome.status === 'mismatch') {
    toast.warning(
      translate(
        'worktree.setupTrust.changedAgain',
        "Setup didn't run: this workspace's orca.yaml changed again since you reviewed it."
      )
    )
  } else if (outcome.status === 'unsupported') {
    toast.warning(
      translate(
        'worktree.setupTrust.hostUnsupported',
        'Approved. Update Orca on the workspace host to run setup for an existing workspace.'
      )
    )
  }
}
