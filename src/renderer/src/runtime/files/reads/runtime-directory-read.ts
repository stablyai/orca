import type { DirEntry } from '../../../../../shared/file-listing/directory-entry'
import type { LocalFileAccess } from '../../../../../shared/file-access/local-file-access'
import type { RuntimeFileOperationArgs } from '../runtime-file-client-types'
import { assertLocalFilesystemFallbackAllowed, getRemoteFileArgs } from '../runtime-file-routing'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'

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
