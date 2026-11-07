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

/**
 * The host created the workspace but skipped setup because its branch's commands differ from the
 * approved ones. Show those commands; approving runs them in the workspace, declining leaves a
 * toast that reopens the review.
 */
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
  reviewCreatedWorktreeSetup(
    { getState, repoId, hostId, worktreeId: result.worktree.id, target },
    mismatch.scriptContent
  )
}

type CreatedWorktreeSetupReview = {
  getState: () => AppState
  repoId: string
  hostId: ExecutionHostId | undefined
  worktreeId: string
  target: RuntimeClientTarget
}

function reviewCreatedWorktreeSetup(
  review: CreatedWorktreeSetupReview,
  scriptContent: string
): void {
  void (async () => {
    const approval = await confirmCreatedWorktreeSetupContent(
      review.getState,
      review.repoId,
      scriptContent,
      review.hostId
    )
    if (approval.decision !== 'run' || approval.approvedContentHash === undefined) {
      showSetupSkippedToast(review, scriptContent)
      return
    }
    const outcome = await runApprovedWorktreeSetup(review.target, {
      worktreeId: review.worktreeId,
      approvedSetupHash: approval.approvedContentHash
    })
    if (outcome.status === 'mismatch') {
      // The file changed again after the review; offer the new content rather than run the old.
      showSetupSkippedToast(review, outcome.setupTrustMismatch.scriptContent, 'changed-again')
    } else if (outcome.status === 'unsupported') {
      toast.warning(
        translate(
          'worktree.setupTrust.hostUnsupported',
          'Approved. Update Orca on the workspace host to run setup for an existing workspace.'
        )
      )
    }
  })().catch((error: unknown) => {
    console.error('Failed to run the approved workspace setup:', error)
    toast.error(translate('worktree.setupTrust.runFailed', 'Could not start setup.'))
  })
}

function showSetupSkippedToast(
  review: CreatedWorktreeSetupReview,
  scriptContent: string,
  reason: 'declined' | 'changed-again' = 'declined'
): void {
  toast.warning(
    reason === 'changed-again'
      ? translate(
          'worktree.setupTrust.changedAgain',
          "Setup didn't run: this workspace's orca.yaml changed again since you reviewed it."
        )
      : translate(
          'worktree.setupTrust.createdBranchSkipped',
          "Setup didn't run: this workspace's branch has different orca.yaml setup commands than the ones you approved."
        ),
    {
      duration: SETUP_SKIPPED_TOAST_MS,
      action: {
        label: translate('worktree.setupTrust.reviewAction', 'Review setup'),
        onClick: () => reviewCreatedWorktreeSetup(review, scriptContent)
      }
    }
  )
}

// Long enough to reach the action; the workspace itself is already usable.
const SETUP_SKIPPED_TOAST_MS = 15_000

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
