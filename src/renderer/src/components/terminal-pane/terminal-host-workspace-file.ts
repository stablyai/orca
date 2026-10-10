import { callHostRoute } from '@/runtime/host-route-call'
import { hostRouteForAuthority } from '@/runtime/runtime-client-target'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import { isRemoteRuntimeFileOperation } from '@/runtime/runtime-file-routing'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { RuntimeTerminalPathResolution } from '../../../../shared/runtime-file-contracts'

export type HostWorkspaceFile = {
  worktreeId: string
  worktreePath: string
  executionHostId: ExecutionHostId
  isDirectory: boolean
}

/** Strips the host's relative suffix; separators are swapped 1:1, so the slice stays byte-exact. */
function workspaceRootOf(absolutePath: string, relativePath: string): string | null {
  if (relativePath === '') {
    return absolutePath
  }
  return absolutePath.replace(/\\/g, '/').endsWith(`/${relativePath}`)
    ? absolutePath.slice(0, absolutePath.length - relativePath.length - 1)
    : null
}

/**
 * A paired-server link outside its own workspace: the server, not this client's catalog copy, says
 * which of its workspaces holds the path. Null when the link is not a paired-server path outside
 * the source workspace; throws when the host cannot open it from any workspace.
 */
export async function resolveHostWorkspaceFile(
  context: RuntimeFileOperationArgs,
  absolutePath: string
): Promise<HostWorkspaceFile | null> {
  const environmentId = context.settings?.activeRuntimeEnvironmentId?.trim()
  if (
    !environmentId ||
    !context.worktreeId ||
    isRemoteRuntimeFileOperation(context, absolutePath)
  ) {
    return null
  }
  const resolved = await callHostRoute<RuntimeTerminalPathResolution>(
    hostRouteForAuthority({ endpoint: { kind: 'environment', environmentId }, at: 'local' }),
    'files.resolveTerminalPath',
    {
      worktree: toRuntimeWorktreeSelector(context.worktreeId),
      pathText: absolutePath,
      crossWorkspace: true
    },
    { timeoutMs: 15_000 }
  )
  const relativePath = resolved.relativePath
  if (relativePath === null || !resolved.absolutePath) {
    // Why: hosts grant reads only inside their workspaces; servers without crossWorkspace land here too.
    throw new Error(`${absolutePath} is outside every workspace on its host`)
  }
  if (!resolved.exists) {
    throw new Error(`File not found on its host: ${absolutePath}`)
  }
  const worktreePath = workspaceRootOf(resolved.absolutePath, relativePath)
  if (worktreePath === null) {
    throw new Error(`The host answered an unexpected path for ${absolutePath}`)
  }
  return {
    worktreeId: resolved.worktree,
    worktreePath,
    executionHostId: toRuntimeExecutionHostId(environmentId),
    isDirectory: resolved.isDirectory
  }
}
