import { callHostRoute } from '@/runtime/host-route-call'
import { hostRouteForAuthority } from '@/runtime/runtime-client-target'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import { statRuntimePath } from '@/runtime/runtime-file-client'
import { isRemoteRuntimeFileOperation } from '@/runtime/runtime-file-routing'
import { userNamedFileAccess } from '@/lib/local-file-access'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import {
  TERMINAL_PATH_CROSS_WORKSPACE_RUNTIME_CAPABILITY,
  type RuntimeTerminalPathResolution
} from '../../../../shared/runtime-file-contracts'

export type HostWorkspaceFile = {
  kind: 'host'
  /** The host's spelling of the path, so the tab's relative path agrees with it. */
  absolutePath: string
  worktreeId: string
  worktreePath: string
  executionHostId: ExecutionHostId
  isDirectory: boolean
}

/** A path the host disowned that this computer has; the user's click here is the only authority to read it. */
export type ClientLocalFile = { kind: 'client'; isDirectory: boolean }

export const CLIENT_LOCAL_FILE_SETTINGS = { activeRuntimeEnvironmentId: null }

/** Strips the host's relative suffix; separators are swapped 1:1, so the slice stays byte-exact. */
function workspaceRootOf(absolutePath: string, relativePath: string): string | null {
  if (relativePath === '') {
    return absolutePath
  }
  return absolutePath.replace(/\\/g, '/').endsWith(`/${relativePath}`)
    ? absolutePath.slice(0, absolutePath.length - relativePath.length - 1)
    : null
}

async function statClientLocalFile(
  environmentId: string,
  absolutePath: string,
  hostRefusal: Error
): Promise<ClientLocalFile> {
  if (
    // Why: a paired web client's filesystem bridge answers from the server, not this computer.
    isPairedWebClientWindow() ||
    !(await runtimeEnvironmentSupportsCapability(
      environmentId,
      TERMINAL_PATH_CROSS_WORKSPACE_RUNTIME_CAPABILITY,
      15_000
    ))
  ) {
    throw hostRefusal
  }
  try {
    const stat = await statRuntimePath(
      { settings: CLIENT_LOCAL_FILE_SETTINGS, worktreeId: null, worktreePath: null },
      absolutePath,
      userNamedFileAccess()
    )
    return { kind: 'client', isDirectory: stat.isDirectory }
  } catch {
    // Why: absent here too, so the host may still hold it outside its workspaces.
    throw hostRefusal
  }
}

/**
 * A clicked paired-server link outside its own workspace: the server, not this client's catalog
 * copy, says which of its workspaces holds the path. A path it disowns without a grant falls to
 * this computer. Null when the link is not a paired-server path outside the source workspace;
 * throws when neither the host nor this computer can open it.
 */
export async function resolveHostWorkspaceFile(
  context: RuntimeFileOperationArgs,
  absolutePath: string
): Promise<HostWorkspaceFile | ClientLocalFile | null> {
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
    const refusal = new Error(`${absolutePath} is outside every workspace on its host`)
    if (resolved.openTarget?.kind === 'absolute-file') {
      // Why: a host grant means the host owns the path; it never becomes a read of this computer.
      throw refusal
    }
    return statClientLocalFile(environmentId, absolutePath, refusal)
  }
  if (!resolved.exists) {
    throw new Error(`File not found on its host: ${absolutePath}`)
  }
  const worktreePath = workspaceRootOf(resolved.absolutePath, relativePath)
  if (worktreePath === null) {
    throw new Error(`The host answered an unexpected path for ${absolutePath}`)
  }
  return {
    kind: 'host',
    absolutePath: resolved.absolutePath,
    worktreeId: resolved.worktree,
    worktreePath,
    executionHostId: toRuntimeExecutionHostId(environmentId),
    isDirectory: resolved.isDirectory
  }
}
