import type { PreloadApi } from '../../../../preload/api-types'
import { resolveRuntimeFilePath } from './web-runtime-worktree-catalog'
import type { WorkspaceWindowNativeBridge } from '../../../../preload/api/workspace-window-native-api'
import { requireActiveEnvironmentOrNull } from './web-runtime-session'
import type { ShellPathScope } from '../../../../preload/api/shell-api'
import { useAppStore } from '@/store'
import { getConnectionIdForFileFromState } from '@/lib/connection-owner-resolution'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { fileUriToFilesystemPath } from '../../../../shared/file-uri-path'

export function createShellApi(): NonNullable<Partial<PreloadApi>['shell']> {
  const native = (window as unknown as { orcaWorkspaceWindowNative?: WorkspaceWindowNativeBridge })
    .orcaWorkspaceWindowNative
  if (native) {
    const workspaceScope = async (path: string): Promise<ShellPathScope> => {
      const state = useAppStore.getState()
      const worktreeId = state.activeWorktreeId
      const unknown: ShellPathScope = { kind: 'workspace', runtimeId: null }
      if (!worktreeId) {
        return unknown
      }
      const connectionId = getConnectionIdForFileFromState(state, worktreeId, path)
      if (connectionId === undefined) {
        return unknown
      }
      const environmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
      const bootstrap = requireActiveEnvironmentOrNull()
      const runtimeId = environmentId
        ? environmentId === bootstrap?.id
          ? bootstrap.runtimeId
          : (await native.runtimeEnvironments.resolve({ selector: environmentId })).runtimeId
        : native.localRuntimeId
      return { kind: 'workspace', runtimeId: runtimeId ?? null, connectionId }
    }
    return {
      ...native.shell,
      openFilePath: async (path, scope) =>
        native.shell.openFilePath(path, scope ?? (await workspaceScope(path))),
      openFileUri: async (uri, scope) => {
        const path = fileUriToFilesystemPath(new URL(uri))
        return native.shell.openFileUri(
          uri,
          scope ?? (path ? await workspaceScope(path) : { kind: 'workspace', runtimeId: null })
        )
      },
      pathExists: async (path, scope) =>
        native.shell.pathExists(path, scope ?? (await workspaceScope(path))),
      copyFile: async (args, scope) => {
        const source = scope ?? (await workspaceScope(args.srcPath))
        const destination = scope ?? (await workspaceScope(args.destPath))
        const local = (owner: ShellPathScope): boolean =>
          owner.kind === 'local-artifact' ||
          (!owner.connectionId && owner.runtimeId === native.localRuntimeId)
        if (!local(source) || !local(destination)) {
          throw new Error('remote-runtime-unsupported')
        }
        return native.shell.copyFile(args, destination)
      },
      openPath: async (path, scope) =>
        native.shell.openPath(path, scope === undefined ? await workspaceScope(path) : scope),
      openInFileManager: async (path, scope) =>
        native.shell.openInFileManager(
          path,
          scope === undefined ? await workspaceScope(path) : scope
        ),
      openInExternalEditor: async (request, scope) => {
        const owner = scope === undefined ? await workspaceScope(request.path) : scope
        return native.shell.openInExternalEditor(
          request,
          owner &&
            typeof owner === 'object' &&
            owner.kind === 'workspace' &&
            request.connectionId &&
            request.connectionId === owner.connectionId
            ? owner.runtimeId
            : owner
        )
      }
    }
  }
  const openResult = { ok: true } as const
  return {
    openPath: (path) =>
      Promise.resolve(window.open(path, '_blank', 'noopener,noreferrer') as never),
    openInFileManager: () => Promise.resolve(openResult),
    openInExternalEditor: () => Promise.resolve(openResult),
    openUrl: (url) => Promise.resolve(window.open(url, '_blank', 'noopener,noreferrer') as never),
    openFilePath: () => Promise.resolve(false),
    openFileUri: (uri) =>
      Promise.resolve(window.open(uri, '_blank', 'noopener,noreferrer') as never),
    pathExists: async (path) => {
      try {
        await resolveRuntimeFilePath(path)
        return true
      } catch {
        return false
      }
    },
    pickAttachment: () => Promise.resolve(null),
    pickImage: () => Promise.resolve(null),
    pickRepoIconImage: () => Promise.resolve(null),
    pickAudio: () => Promise.resolve(null),
    pickDirectory: () => Promise.resolve(null),
    copyFile: () => Promise.resolve()
  }
}
