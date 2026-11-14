/** How a host's `files.*` methods name one file: by its workspace path, or by the grant the host issued for a file outside every workspace. */
export type RemoteFileLocator =
  | { relativePath: string; grantId?: never; absolutePath?: never }
  | { grantId: string; absolutePath: string; relativePath?: never }

type RemoteFileOperation = 'read' | 'preview' | 'stat' | 'readChunk'

const WORKSPACE_FILE_METHODS = {
  read: 'files.read',
  preview: 'files.readPreview',
  stat: 'files.stat',
  readChunk: 'files.readChunk'
} as const satisfies Record<RemoteFileOperation, string>

const GRANTED_FILE_METHODS = {
  read: 'files.readTerminalArtifact',
  preview: 'files.readTerminalArtifactPreview',
  stat: 'files.statTerminalArtifact',
  readChunk: 'files.readTerminalArtifactChunk'
} as const satisfies Record<RemoteFileOperation, string>

/** The path that names the file's type; a granted file's is absolute. */
export function remoteFilePath(locator: RemoteFileLocator): string {
  return locator.grantId === undefined ? locator.relativePath : locator.absolutePath
}

/** The host method and its file params for one operation on the located file. */
export function remoteFileRequest<Op extends RemoteFileOperation>(
  worktree: string,
  locator: RemoteFileLocator,
  operation: Op
): {
  method: (typeof WORKSPACE_FILE_METHODS)[Op] | (typeof GRANTED_FILE_METHODS)[Op]
  params: Record<string, string>
} {
  return locator.grantId === undefined
    ? {
        method: WORKSPACE_FILE_METHODS[operation],
        params: { worktree, relativePath: locator.relativePath }
      }
    : {
        method: GRANTED_FILE_METHODS[operation],
        params: { worktree, grantId: locator.grantId, absolutePath: locator.absolutePath }
      }
}
