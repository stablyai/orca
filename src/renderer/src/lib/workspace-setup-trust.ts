import type { AppState } from '@/store/types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { SetupDecision } from '../../../shared/worktree/create-types'
import { ensureHooksConfirmed } from './ensure-hooks-confirmed'
import { settleComposerSubmit } from './composer-submit-cancellation'

export async function confirmWorkspaceSetupDecision<T extends SetupDecision | undefined>(
  stateOrGetter: AppState | (() => AppState),
  repoId: string,
  decision: T,
  ownerHostId: ExecutionHostId | undefined,
  isCancelled: () => boolean,
  signal?: AbortSignal
): Promise<{ setupDecision: T | 'skip'; trustDecision: 'run' | 'skip' } | 'cancelled'> {
  const trust = await settleComposerSubmit(
    ensureHooksConfirmed(
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
  return { setupDecision: trust.value === 'skip' ? 'skip' : decision, trustDecision: trust.value }
}
