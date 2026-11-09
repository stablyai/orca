import type { AppState } from '@/store/types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { SetupDecision } from '../../../shared/worktree/create-types'
import type { ApprovedSetupHashes } from '../../../shared/worktree/approved-setup-hashes'
import { approvedOrcaHookContentHashes } from '../../../shared/orca-hook-trust-entries'
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
  ({ setupDecision: T | 'skip'; trustDecision: 'run' | 'skip' } & ApprovedSetupHashes) | 'cancelled'
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
  if (trustDecision !== 'run' || approvedContentHash === undefined) {
    return { setupDecision: trustDecision === 'skip' ? 'skip' : decision, trustDecision }
  }
  // The host runs shared setup only if the created branch's content hashes to one of these.
  const state = typeof stateOrGetter === 'function' ? stateOrGetter() : stateOrGetter
  const approvedSetupHashes = approvedOrcaHookContentHashes(
    state.trustedOrcaHooks,
    repoId,
    'setup'
  ).filter((hash) => hash !== approvedContentHash)
  return {
    setupDecision: decision,
    trustDecision,
    approvedSetupHash: approvedContentHash,
    ...(approvedSetupHashes.length > 0 ? { approvedSetupHashes } : {})
  }
}
