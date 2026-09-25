import type { AppState } from '@/store/types'
import { ensureHooksConfirmed } from '@/lib/ensure-hooks-confirmed'
import { resolveDirectSetupDecision } from '@/lib/launch-work-item-direct-preflight'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import type { SetupDecision } from '../../../shared/worktree/create-types'
import type { Worktree } from '../../../shared/worktree/types'
import { findForkWorktreeRepo, forkWorktreeOwnerSettings } from './agent-session-fork-source-repo'

type ForkSetupSource = Pick<Worktree, 'repoId' | 'hostId' | 'runtimeOwnerEnvironmentId'>

/** The setup decision a fork creates its child with: the repo policy, gated by orca.yaml trust. */
export async function resolveForkSetupDecision(
  state: AppState,
  source: ForkSetupSource
): Promise<SetupDecision> {
  const repo = findForkWorktreeRepo(state, source)
  if (!repo) {
    return 'skip'
  }
  const policy = await resolveDirectSetupDecision(
    repo.id,
    repo,
    forkWorktreeOwnerSettings(state, source)
  )
  // Why: an 'ask' repo needs a per-workspace choice the fork dialog does not offer, so it creates without setup.
  if (policy.kind === 'needs-modal' || policy.decision === 'skip') {
    return 'skip'
  }
  // Why: main does not check trust; a committed orca.yaml setup or default-tab command must be confirmed here.
  const trust = await ensureHooksConfirmed(
    state,
    repo.id,
    'setup',
    getRepoExecutionHostId(repo),
    source.runtimeOwnerEnvironmentId
  )
  return trust === 'skip' ? 'skip' : policy.decision
}
