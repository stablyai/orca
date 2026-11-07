import type { AppState } from '@/store/types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { SetupDecision } from '../../../shared/worktree/create-types'
import { ensureHooksApproved } from './ensure-hooks-confirmed'
import { settleComposerSubmit } from './composer-submit-cancellation'

export async function confirmWorkspaceSetupDecision<T extends SetupDecision | undefined>(
  stateOrGetter: AppState | (() => AppState),
  repoId: string,
  decision: T,
  ownerHostId: ExecutionHostId | undefined,
  isCancelled: () => boolean,
  signal?: AbortSignal
): Promise<
  | { setupDecision: T | 'skip'; trustDecision: 'run' | 'skip'; approvedSetupHash?: string }
  | 'cancelled'
> {
  const trust = await settleComposerSubmit(
    ensureHooksApproved(
      stateOrGetter,
      repoId,
      'setup',
      ownerHostId,
      undefined,
      isCancelled,
      signal
    ),
    isCancelled
  )
  if (trust.status === 'cancelled') {
    return 'cancelled'
  }
  const { decision: trustDecision, approvedContentHash } = trust.value
  // The host runs shared setup only if the created branch's content hashes to this.
  return {
    setupDecision: trustDecision === 'skip' ? 'skip' : decision,
    trustDecision,
    ...(trustDecision === 'run' && approvedContentHash !== undefined
      ? { approvedSetupHash: approvedContentHash }
      : {})
  }
}
