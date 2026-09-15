import type { ShellApi, ShellPathScope } from '../../../preload/api/shell-api'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { fileUriToFilesystemPath } from '../../../shared/file-uri-path'
import { getConnectionIdForFileFromState } from './connection-owner-resolution'
import { getRuntimeEnvironmentIdForWorktree } from './worktree-runtime-owner'
import { resolveWorktreeOperationRouteForHost } from './worktree-operation-route'

type WorkspaceShellOwner = {
  worktreeId: string | null
  executionHostId?: ExecutionHostId
  runtimeEnvironmentId?: string | null
  connectionId?: string | null
}

export async function resolveWorkspaceShellScope(
  owner: WorkspaceShellOwner,
  path: string
): Promise<ShellPathScope> {
  const native = window.orcaWorkspaceWindowNative
  const unknown: ShellPathScope = { kind: 'workspace', runtimeId: null }
  if (!native || !owner.worktreeId) {
    return unknown
  }
  const { useAppStore } = await import('@/store')
  const state = useAppStore.getState()
  const route = owner.executionHostId
    ? resolveWorktreeOperationRouteForHost(state, owner.worktreeId, owner.executionHostId)
    : null
  const host = parseExecutionHostId(owner.executionHostId)
  const connectionId =
    owner.connectionId !== undefined
      ? owner.connectionId
      : host?.kind === 'ssh'
        ? host.targetId
        : getConnectionIdForFileFromState(state, owner.worktreeId, path)
  if (connectionId === undefined) {
    return unknown
  }
  const environmentId =
    owner.runtimeEnvironmentId ??
    route?.runtimeEnvironmentId ??
    getRuntimeEnvironmentIdForWorktree(state, owner.worktreeId)
  const runtimeId = environmentId
    ? (await window.api.runtimeEnvironments.resolve({ selector: environmentId })).runtimeId
    : native.localRuntimeId
  return { kind: 'workspace', runtimeId: runtimeId ?? null, connectionId }
}

export function getWorkspaceShellApi(owner: WorkspaceShellOwner): ShellApi {
  const shell = window.api.shell
  if (!window.orcaWorkspaceWindowNative) {
    return shell
  }
  const scope = (path: string) => resolveWorkspaceShellScope(owner, path)
  const local = (value: ShellPathScope) =>
    value.kind === 'local-artifact' ||
    (!value.connectionId && value.runtimeId === window.orcaWorkspaceWindowNative?.localRuntimeId)
  return {
    ...shell,
    openPath: async (path, explicit) => shell.openPath(path, explicit ?? (await scope(path))),
    openInFileManager: async (path, explicit) =>
      shell.openInFileManager(path, explicit ?? (await scope(path))),
    openFilePath: async (path, explicit) =>
      shell.openFilePath(path, explicit ?? (await scope(path))),
    openFileUri: async (uri, explicit) =>
      shell.openFileUri(
        uri,
        explicit ?? (await scope(fileUriToFilesystemPath(new URL(uri)) ?? ''))
      ),
    pathExists: async (path, explicit) => shell.pathExists(path, explicit ?? (await scope(path))),
    copyFile: async (args, explicit) => {
      const source = explicit ?? (await scope(args.srcPath))
      const destination = explicit ?? (await scope(args.destPath))
      if (!local(source) || !local(destination)) {
        throw new Error('remote-runtime-unsupported')
      }
      return shell.copyFile(args, destination)
    }
  }
}
