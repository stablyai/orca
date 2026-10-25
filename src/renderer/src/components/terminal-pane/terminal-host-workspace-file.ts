import { callHostRoute } from '@/runtime/host-route-call'
import { hostRouteForAuthority, runtimeTargetEnvironmentId } from '@/runtime/runtime-client-target'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import { statRuntimePath } from '@/runtime/runtime-file-metadata-client'
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

/** A host file outside every workspace that the host granted because this terminal printed it. */
export type HostGrantedFile = {
  kind: 'grant'
  /** The host's canonical path; the grant is bound to it. */
  absolutePath: string
  grantId: string
  isDirectory: false
}

/** The host answered: it has no file there this client may open. Transport failures stay other errors. */
export class HostFileRefusal extends Error {}

export const CLIENT_LOCAL_FILE_TARGET: RuntimeClientTarget = { kind: 'local' }

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
      { target: CLIENT_LOCAL_FILE_TARGET, worktreeId: null, worktreePath: null },
      absolutePath,
      userNamedFileAccess()
    )
    return { kind: 'client', isDirectory: stat.isDirectory }
  } catch {
    // Why: absent here too, so the host may still hold it outside its workspaces.
    throw hostRefusal
  }
}

/** For paired paths outside the source workspace, ask the server for an owning workspace or terminal grant; only disowned ungranted paths fall to this computer. Null when inapplicable; rejects when neither can open. */
export async function resolveHostWorkspaceFile(
  context: RuntimeFileOperationArgs,
  absolutePath: string,
  terminalHandle?: string | null
): Promise<HostWorkspaceFile | HostGrantedFile | ClientLocalFile | null> {
  const environmentId = runtimeTargetEnvironmentId(context.target)
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
      crossWorkspace: true,
      // Why: the host grants a file outside its workspaces only to the terminal that printed it.
      ...(terminalHandle ? { terminal: terminalHandle } : {})
    },
    { timeoutMs: 15_000 }
  )
  const relativePath = resolved.relativePath
  if (relativePath === null || !resolved.absolutePath) {
    // Why: hosts grant reads only inside their workspaces; servers without crossWorkspace land here too.
    const refusal = new HostFileRefusal(`${absolutePath} is outside every workspace on its host`)
    const openTarget = resolved.openTarget
    if (openTarget?.kind === 'absolute-file') {
      // Why: a host grant means the host owns the path; it never becomes a read of this computer.
      return {
        kind: 'grant',
        absolutePath: openTarget.absolutePath,
        grantId: openTarget.grantId,
        isDirectory: false
      }
    }
    if (resolved.exists) {
      // Why: an ungranted host path (a directory, or one no terminal printed) is still the host's.
      throw refusal
    }
    return statClientLocalFile(environmentId, absolutePath, refusal)
  }
  if (!resolved.exists) {
    throw new HostFileRefusal(`File not found on its host: ${absolutePath}`)
  }
  const worktreePath = workspaceRootOf(resolved.absolutePath, relativePath)
  if (worktreePath === null) {
    throw new HostFileRefusal(`The host answered an unexpected path for ${absolutePath}`)
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
