import type { GitLineBlameResult } from '../../../shared/git-line-blame-types'
import { GIT_BLAME_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { resolveLocalWorktreePath, type RuntimeGitContext } from './runtime-git-client-context'
import {
  callRuntimeRpc,
  getActiveRuntimeTarget,
  runtimeEnvironmentSupportsCapability
} from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

/**
 * Authorship for every line of a file, in one walk.
 *
 * Why the capability check: older hosts answer with method_not_found, and the
 * blame surfaces must degrade to "no authorship" rather than surface an error.
 */
export async function getRuntimeGitFileBlame(
  context: RuntimeGitContext,
  args: { filePath: string }
): Promise<Record<number, GitLineBlameResult> | null> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.fileBlame({
      worktreePath: resolveLocalWorktreePath(context),
      filePath: args.filePath,
      connectionId: context.connectionId
    })
  }
  if (
    !(await runtimeEnvironmentSupportsCapability(
      target.environmentId,
      GIT_BLAME_RUNTIME_CAPABILITY
    ))
  ) {
    return null
  }
  return callRuntimeRpc<Record<number, GitLineBlameResult> | null>(target, 'git.fileBlame', {
    worktree: toRuntimeWorktreeSelector(context.worktreeId),
    ...args
  })
}

/** Authorship for one 1-indexed line; the fallback when a whole-file read is unavailable. */
export async function getRuntimeGitLineBlame(
  context: RuntimeGitContext,
  args: { filePath: string; line: number }
): Promise<GitLineBlameResult | null> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.lineBlame({
      worktreePath: resolveLocalWorktreePath(context),
      filePath: args.filePath,
      line: args.line,
      connectionId: context.connectionId
    })
  }
  if (
    !(await runtimeEnvironmentSupportsCapability(
      target.environmentId,
      GIT_BLAME_RUNTIME_CAPABILITY
    ))
  ) {
    return null
  }
  return callRuntimeRpc<GitLineBlameResult | null>(target, 'git.lineBlame', {
    worktree: toRuntimeWorktreeSelector(context.worktreeId),
    ...args
  })
}
