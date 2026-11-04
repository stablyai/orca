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
import { HostFileRefusal, hostAbsentRefusal } from './host-file-refusal'
import { hostSavesGrantedFiles } from '@/runtime/runtime-terminal-artifact-grant'

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

/** A host file outside every workspace, readable through the grant the host issued for it. */
export type HostGrantedFile = {
  kind: 'grant'
  /** The host's canonical path; the grant is bound to it. */
  absolutePath: string
  grantId: string
  isDirectory: false
  /** Older hosts mint read-only grants for chat-cited files. */
  readOnly: boolean
}

/** Editor tab fields for a granted host file: the grant is its only read and write authority; older hosts may grant read-only. */
export function hostGrantedEditorFields(grant: HostGrantedFile): {
  terminalArtifactGrantId: string
  readOnly?: true
} {
  return { terminalArtifactGrantId: grant.grantId, ...(grant.readOnly ? { readOnly: true } : {}) }
}

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
  absolutePath: string
): Promise<ClientLocalFile> {
  // Why: built only on refusal, so a local file that opens costs no extra host status check.
  const hostRefusal = (): Promise<Error> => hostAbsentRefusal(environmentId, absolutePath)
  if (
    // Why: a paired web client's filesystem bridge answers from the server, not this computer.
    isPairedWebClientWindow() ||
    !(await runtimeEnvironmentSupportsCapability(
      environmentId,
      TERMINAL_PATH_CROSS_WORKSPACE_RUNTIME_CAPABILITY,
      15_000
    ))
  ) {
    throw await hostRefusal()
  }
  let stat: Awaited<ReturnType<typeof statRuntimePath>>
  try {
    stat = await statRuntimePath(
      { target: CLIENT_LOCAL_FILE_TARGET, worktreeId: null, worktreePath: null },
      absolutePath,
      userNamedFileAccess()
    )
  } catch {
    // Why: absent here too, so the host may still hold it outside its workspaces.
    throw await hostRefusal()
  }
  return { kind: 'client', isDirectory: stat.isDirectory }
}

/** For paired paths outside the source workspace, ask the server for an owning workspace or a file grant; only paths the host lacks fall to this computer. Null when inapplicable; rejects when neither can open. */
export async function resolveHostWorkspaceFile(
  context: RuntimeFileOperationArgs,
  absolutePath: string,
  source: { terminalHandle?: string | null; hostFileOnly?: boolean } = {}
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
      // Why: older hosts grant a file outside their workspaces only to the terminal that printed it.
      ...(source.terminalHandle ? { terminal: source.terminalHandle } : {})
    },
    { timeoutMs: 15_000 }
  )
  const relativePath = resolved.relativePath
  if (relativePath === null || !resolved.absolutePath) {
    const openTarget = resolved.openTarget
    if (openTarget?.kind === 'absolute-file') {
      // Why: a host grant means the host owns the path; it never becomes a read of this computer.
      return {
        kind: 'grant',
        absolutePath: openTarget.absolutePath,
        grantId: openTarget.grantId,
        isDirectory: false,
        readOnly: openTarget.readOnly === true || !(await hostSavesGrantedFiles(environmentId))
      }
    }
    if (resolved.exists) {
      // Why: hosts grant files, not folders; the folder is still the host's, never this computer's.
      throw new HostFileRefusal(`${absolutePath} is a folder outside every workspace on its host`)
    }
    if (source.hostFileOnly) {
      throw new HostFileRefusal(`File not found on its host: ${absolutePath}`)
    }
    return statClientLocalFile(environmentId, absolutePath)
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
