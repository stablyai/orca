import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AppState } from '@/store/types'
import { confirmCreatedWorktreeSetupContent } from '@/lib/ensure-hooks-confirmed'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { CreateWorktreeResult } from '../../../../../../shared/worktree/create-types'

/** The host skipped setup because the created branch's commands differ; ask about the real ones. */
export function reviewSetupTrustMismatch(
  getState: () => AppState,
  repoId: string,
  hostId: ExecutionHostId | undefined,
  result: Pick<CreateWorktreeResult, 'setupTrustMismatch'>
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
  void confirmCreatedWorktreeSetupContent(getState, repoId, mismatch.scriptContent, hostId).catch(
    (error: unknown) => console.error('Failed to review the workspace setup commands:', error)
  )
}
