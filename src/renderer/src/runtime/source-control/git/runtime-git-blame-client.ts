import type { GitBlameResult } from '../../../../../shared/git/blame/git-blame-types'
import { GIT_BLAME_CAPABILITY } from '../../../../../shared/source-control/runtime/git-graph-capabilities'
import { resolveLocalWorktreePath, type RuntimeGitContext } from './runtime-git-client-context'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import { toRuntimeWorktreeSelector } from '../../rpc/targets/runtime-worktree-selector'
import { runtimeEnvironmentSupportsCapability } from '../../rpc/compatibility/runtime-capability-proof'

const UNAVAILABLE: GitBlameResult = { kind: 'unavailable' }

/** Blame is passive: older hosts and failed reads show nothing rather than an error. */
export async function getRuntimeGitBlame(
  context: RuntimeGitContext,
  filePath: string,
  knownHeadOid?: string
): Promise<GitBlameResult> {
  const target = context.target
  try {
    if (target.kind === 'local' || !context.worktreeId) {
      return await window.api.git.blame({
        worktreePath: resolveLocalWorktreePath(context),
        filePath,
        knownHeadOid,
        connectionId: context.connectionId
      })
    }
    if (!(await runtimeEnvironmentSupportsCapability(target.environmentId, GIT_BLAME_CAPABILITY))) {
      return UNAVAILABLE
    }
    return await callRuntimeRpc<GitBlameResult>(
      target,
      'git.blame',
      { worktree: toRuntimeWorktreeSelector(context.worktreeId), filePath, knownHeadOid },
      // Large files with long history take seconds to blame.
      { timeoutMs: 120_000 }
    )
  } catch {
    return UNAVAILABLE
  }
}
