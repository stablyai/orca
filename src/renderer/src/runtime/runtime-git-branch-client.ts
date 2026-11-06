import type { BranchSwitchTarget } from '../../../shared/git/branch-switch-target'
import type {
  RuntimeGitLocalBranches,
  RuntimeGitSwitchResult,
  RuntimeRepoSearchRefs
} from '../../../shared/runtime-worktree-contracts'
import type { RuntimeGitContext } from './runtime-git-client-context'
import { callRuntimeRpc } from './runtime-rpc-client'
import { RuntimeRpcCallError } from './runtime-rpc-result'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

export async function switchRuntimeGitBranch(
  context: RuntimeGitContext,
  target: BranchSwitchTarget,
  hostLabel = context.target.kind === 'environment' ? context.target.environmentId : 'this computer'
): Promise<RuntimeGitSwitchResult> {
  try {
    return await callRuntimeRpc<RuntimeGitSwitchResult>(context.target, 'git.switchBranch', {
      worktree: toRuntimeWorktreeSelector(context.worktreeId ?? ''),
      target
    })
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      throw new Error(`Update Orca on ${hostLabel} to switch branches from here.`)
    }
    throw error
  }
}
export function listRuntimeGitBranches(
  context: RuntimeGitContext
): Promise<RuntimeGitLocalBranches> {
  return callRuntimeRpc(context.target, 'git.localBranches', {
    worktree: toRuntimeWorktreeSelector(context.worktreeId ?? '')
  })
}
export function searchRuntimeRemoteBranches(
  context: RuntimeGitContext,
  repoId: string,
  query: string
): Promise<RuntimeRepoSearchRefs> {
  return callRuntimeRpc(context.target, 'repo.searchRefs', {
    repo: repoId,
    query,
    limit: 50,
    namespace: 'remote'
  })
}
export function branchSwitchExistingBranch(error: unknown): string | null {
  if (!(error instanceof RuntimeRpcCallError)) {
    return null
  }
  const data = error.response.error.data
  return typeof data === 'object' &&
    data !== null &&
    'existingBranch' in data &&
    typeof data.existingBranch === 'string'
    ? data.existingBranch
    : null
}
