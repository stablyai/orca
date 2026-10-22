import type { GitBlameResult } from '../../../shared/git-blame-types'
import { REMOTE_RUNTIME_MAX_FILE_WRITE_CONTENT_BYTES } from '../../../shared/remote-runtime-memory-limits'
import { hasRuntimeRpcErrorCode } from '../../../shared/runtime-rpc-error-code'
import { resolveLocalWorktreePath, type RuntimeGitContext } from './runtime-git-client-context'
import { callRuntimeRpc } from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

function fitsOneRemoteRequest(contents: string): boolean {
  // Why: one UTF-16 unit escapes to at most 6 bytes, so most buffers skip encoding.
  if (contents.length * 6 + 2 <= REMOTE_RUNTIME_MAX_FILE_WRITE_CONTENT_BYTES) {
    return true
  }
  return (
    new TextEncoder().encode(JSON.stringify(contents)).length <=
    REMOTE_RUNTIME_MAX_FILE_WRITE_CONTENT_BYTES
  )
}

/** Resolves null when the file has no blame (untracked, not a repo, too large, older host). */
export async function getRuntimeGitFileBlame(
  context: RuntimeGitContext,
  args: { filePath: string; contents?: string }
): Promise<GitBlameResult | null> {
  const target = context.target
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.blame({
      worktreePath: resolveLocalWorktreePath(context),
      filePath: args.filePath,
      contents: args.contents,
      connectionId: context.connectionId
    })
  }
  // Why: an oversized frame makes the host drop the whole connection, not just this call.
  if (args.contents !== undefined && !fitsOneRemoteRequest(args.contents)) {
    return null
  }
  try {
    return await callRuntimeRpc<GitBlameResult | null>(
      target,
      'git.blame',
      { worktree: toRuntimeWorktreeSelector(context.worktreeId), ...args },
      { timeoutMs: 30_000 }
    )
  } catch (error) {
    // Why: a host older than this RPC simply has no blame to offer.
    if (hasRuntimeRpcErrorCode(error, 'method_not_found')) {
      return null
    }
    throw error
  }
}
