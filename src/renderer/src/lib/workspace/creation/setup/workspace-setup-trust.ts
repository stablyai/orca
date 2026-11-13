import type { AppState } from '@/store/types'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { isFolderRepo } from '../../../../../../shared/repo-kind'
import type { SetupDecision } from '../../../../../../shared/worktree/create-types'
import type { ApprovedSetupHashes } from '../../../../../../shared/worktree/creation/approved-setup-hashes'
import { approvedOrcaHookContentHashes } from '../../../../../../shared/orca-hook-trust-entries'
import { ensureHooksApproved } from '../../../../runtime/repo-hooks/ensure-hooks-confirmed'
import { settleComposerSubmit } from '../composer-submit-cancellation'
import type { SetupHooksCreateSource } from '../../../../../../shared/worktree/setup-hooks-create-source'

export async function confirmWorkspaceSetupDecision<T extends SetupDecision | undefined>(
  stateOrGetter: AppState | (() => AppState),
  repoId: string,
  decision: T,
  ownerHostId: ExecutionHostId | undefined,
  isCancelled: () => boolean,
  signal?: AbortSignal,
  createSource?: SetupHooksCreateSource
): Promise<
  | ({ setupDecision: T | 'skip' | 'run'; trustDecision: 'run' | 'skip' } & ApprovedSetupHashes)
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
      signal,
      createSource
    ),
    isCancelled
  )
  if (trust.status === 'cancelled') {
    return 'cancelled'
  }
  const { decision: trustDecision, approvedContentHash } = trust.value
  const state = typeof stateOrGetter === 'function' ? stateOrGetter() : stateOrGetter
  if (trustDecision !== 'run' || approvedContentHash === undefined) {
    return {
      setupDecision:
        trustDecision === 'skip'
          ? 'skip'
          : explicitFolderRunUnderRepoTrust(state, repoId, ownerHostId, decision),
      trustDecision
    }
  }
  // The host runs shared setup only if the created branch's content hashes to one of these.
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

/**
 * Whole-project trust carries no content hash, and a folder host skips unhashed shared setup as an
 * older client's. Say "run" outright where the project's policy would run it anyway.
 */
function explicitFolderRunUnderRepoTrust<T extends SetupDecision | undefined>(
  state: AppState,
  repoId: string,
  ownerHostId: ExecutionHostId | undefined,
  decision: T
): T | 'run' {
  if (decision !== undefined && decision !== 'inherit') {
    return decision
  }
  const repo = state.repos.find(
    (candidate) =>
      candidate.id === repoId && (!ownerHostId || getRepoExecutionHostId(candidate) === ownerHostId)
  )
  return repo &&
    isFolderRepo(repo) &&
    (repo.hookSettings?.setupRunPolicy ?? 'run-by-default') === 'run-by-default'
    ? 'run'
    : decision
}
