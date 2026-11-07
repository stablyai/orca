import type { DirEntry } from '../../../../../shared/filesystem-entry-types'
import type { LocalFileAccess } from '../../../../../shared/local-file-access'
import type { RuntimeFileOperationArgs } from '../runtime-file-client-types'
import { assertLocalFilesystemFallbackAllowed, getRemoteFileArgs } from '../runtime-file-routing'
import { callRuntimeRpc } from '../../runtime-rpc-client'

export async function readRuntimeDirectory(
  context: RuntimeFileOperationArgs,
  dirPath: string,
  {
    wakeWslDistro,
    access,
    ...options
  }: { followSymlinks?: boolean; wakeWslDistro?: boolean; access?: LocalFileAccess } = {}
): Promise<DirEntry[]> {
  const remoteArgs = getRemoteFileArgs(context, dirPath)
  if (!remoteArgs) {
    assertLocalFilesystemFallbackAllowed(context)
    return window.api.fs.readDir({
      dirPath,
      connectionId: context.connectionId,
      ...options,
      ...(wakeWslDistro ? { wakeWslDistro } : {}),
      ...(access ? { access } : {})
    })
  }
  return callRuntimeRpc<DirEntry[]>(
    remoteArgs.target,
    'files.readDir',
    { worktree: remoteArgs.worktreeSelector, relativePath: remoteArgs.relativePath, ...options },
    { timeoutMs: 15_000 }
  )
}
