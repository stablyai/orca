import type { DirEntry } from '../../../shared/filesystem-entry-types'
import { normalizeRelativePath } from '@/lib/path'
import { callRuntimeRpc } from './runtime-rpc-client'
import type { RuntimeFileOperationArgs } from './runtime-file-client-types'
import {
  assertLocalFilesystemFallbackAllowed,
  canReadRelativeRuntimeFile,
  getRelativePathInsideWorktree,
  getRemoteFileArgs,
  withSshMutationExpectation
} from './runtime-file-routing'
import { callRuntimeFileMutation } from './runtime-file-mutation-rpc'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import type { LocalFileAccess } from '../../../shared/local-file-access'
import { localAccess } from './runtime-file-read-client'
import { REMOTE_RUNTIME_MAX_FILE_WRITE_CONTENT_BYTES } from '../../../shared/remote-runtime/remote-runtime-memory-limits'
import {
  FILE_WRITE_OK,
  parseFileWriteResult,
  type FileWriteDiskPrecondition,
  type FileWriteResult
} from '../../../shared/file-write-disk-precondition'
import { writeRemoteFileIfUnchanged } from './runtime-file-write-disk-precondition'
import { writeRemoteFileStaged } from './runtime-staged-file-save'

/** Null when the content fits one request; otherwise the refusal an older host's frame cap needs. */
function remoteWriteTooLargeError(content: string): Error | null {
  // Why: one UTF-16 unit escapes to at most 6 bytes, so most saves skip encoding.
  if (content.length * 6 + 2 <= REMOTE_RUNTIME_MAX_FILE_WRITE_CONTENT_BYTES) {
    return null
  }
  const bytes = new TextEncoder().encode(JSON.stringify(content)).length
  return bytes > REMOTE_RUNTIME_MAX_FILE_WRITE_CONTENT_BYTES
    ? new Error(
        `File is too large to save to a remote Orca server (${Math.ceil(bytes / 1024)} KB; the limit is ${REMOTE_RUNTIME_MAX_FILE_WRITE_CONTENT_BYTES / 1024} KB).`
      )
    : null
}

/** Refuses a save the host's frame cap would reject by dropping the whole connection. */
export function assertRemoteWriteFitsOneRequest(content: string): void {
  const tooLarge = remoteWriteTooLargeError(content)
  if (tooLarge) {
    throw tooLarge
  }
}

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
      ...localAccess(context.connectionId, access)
    })
  }
  const remoteOptions = options.followSymlinks ? { followSymlinks: true } : {}
  return callRuntimeRpc<DirEntry[]>(
    remoteArgs.target,
    'files.readDir',
    {
      worktree: remoteArgs.worktreeSelector,
      relativePath: remoteArgs.relativePath,
      ...remoteOptions
    },
    { timeoutMs: 15_000 }
  )
}

/** With `diskPrecondition`, a write whose target no longer matches the baseline is refused, not written. */
export async function writeRuntimeFile(
  context: RuntimeFileOperationArgs,
  filePath: string,
  content: string,
  access?: LocalFileAccess,
  diskPrecondition?: FileWriteDiskPrecondition,
  /** Runs at the last moment before the bytes are sent; throwing aborts the write. */
  beforeSend?: () => void
): Promise<FileWriteResult> {
  const remoteArgs = getRemoteFileArgs(context, filePath)
  if (!remoteArgs) {
    assertLocalFilesystemFallbackAllowed(context)
    beforeSend?.()
    return parseFileWriteResult(
      await window.api.fs.writeFile(
        withSshMutationExpectation(context, {
          filePath,
          content,
          connectionId: context.connectionId,
          ...localAccess(context.connectionId, access),
          ...(diskPrecondition ? { diskPrecondition } : {})
        })
      )
    )
  }
  const tooLarge = remoteWriteTooLargeError(content)
  if (tooLarge) {
    const target = remoteArgs.target
    const location = withSshMutationExpectation(context, {
      worktree: remoteArgs.worktreeSelector,
      relativePath: remoteArgs.relativePath
    })
    return writeRemoteFileStaged(
      target,
      location,
      content,
      diskPrecondition,
      () => tooLarge,
      beforeSend
    )
  }
  const params = withSshMutationExpectation(context, {
    worktree: remoteArgs.worktreeSelector,
    relativePath: remoteArgs.relativePath,
    content
  })
  if (!diskPrecondition) {
    await callRuntimeFileMutation(
      remoteArgs.target,
      'files.write',
      params,
      15_000,
      undefined,
      beforeSend
    )
    return FILE_WRITE_OK
  }
  return writeRemoteFileIfUnchanged(
    { ...context, target: remoteArgs.target },
    filePath,
    content,
    params,
    diskPrecondition,
    beforeSend
  )
}

export async function createRuntimePath(
  context: RuntimeFileOperationArgs,
  path: string,
  kind: 'file' | 'directory'
): Promise<void> {
  const remoteArgs = getRemoteFileArgs(context, path)
  if (!remoteArgs) {
    assertLocalFilesystemFallbackAllowed(context)
    await (kind === 'directory'
      ? window.api.fs.createDir(
          withSshMutationExpectation(context, { dirPath: path, connectionId: context.connectionId })
        )
      : window.api.fs.createFile(
          withSshMutationExpectation(context, {
            filePath: path,
            connectionId: context.connectionId
          })
        ))
    return
  }
  await callRuntimeFileMutation(
    remoteArgs.target,
    kind === 'directory' ? 'files.createDir' : 'files.createFile',
    withSshMutationExpectation(context, {
      worktree: remoteArgs.worktreeSelector,
      relativePath: remoteArgs.relativePath
    }),
    15_000
  )
}

export async function renameRuntimePath(
  context: RuntimeFileOperationArgs,
  oldPath: string,
  newPath: string,
  access?: LocalFileAccess
): Promise<void> {
  const oldRemoteArgs = getRemoteFileArgs(context, oldPath)
  const newRelativePath = getRelativePathInsideWorktree(context.worktreePath, newPath)
  if (!oldRemoteArgs || newRelativePath === null) {
    assertLocalFilesystemFallbackAllowed(context)
    await window.api.fs.rename(
      withSshMutationExpectation(context, {
        oldPath,
        newPath,
        connectionId: context.connectionId,
        ...localAccess(context.connectionId, access)
      })
    )
    return
  }
  await callRuntimeFileMutation(
    oldRemoteArgs.target,
    'files.rename',
    withSshMutationExpectation(context, {
      worktree: oldRemoteArgs.worktreeSelector,
      oldRelativePath: oldRemoteArgs.relativePath,
      newRelativePath
    }),
    15_000
  )
}

export async function copyRuntimePath(
  context: RuntimeFileOperationArgs,
  sourcePath: string,
  destinationPath: string
): Promise<void> {
  const sourceArgs = getRemoteFileArgs(context, sourcePath)
  const destinationArgs = getRemoteFileArgs(context, destinationPath)
  if (!sourceArgs || !destinationArgs) {
    assertLocalFilesystemFallbackAllowed(context)
    await window.api.fs.copy(
      withSshMutationExpectation(context, {
        sourcePath,
        destinationPath,
        connectionId: context.connectionId
      })
    )
    return
  }
  await callRuntimeFileMutation(
    sourceArgs.target,
    'files.copy',
    withSshMutationExpectation(context, {
      worktree: sourceArgs.worktreeSelector,
      sourceRelativePath: sourceArgs.relativePath,
      destinationRelativePath: destinationArgs.relativePath
    }),
    15_000
  )
}

export async function deleteRuntimePath(
  context: RuntimeFileOperationArgs,
  targetPath: string,
  recursive?: boolean,
  options?: { permanent?: boolean }
): Promise<void> {
  const remoteArgs = getRemoteFileArgs(context, targetPath)
  if (!remoteArgs) {
    assertLocalFilesystemFallbackAllowed(context)
    await window.api.fs.deletePath(
      withSshMutationExpectation(context, {
        targetPath,
        connectionId: context.connectionId,
        recursive,
        ...(options?.permanent === true ? { permanent: true } : {})
      })
    )
    return
  }
  await callRuntimeFileMutation(
    remoteArgs.target,
    'files.delete',
    withSshMutationExpectation(context, {
      worktree: remoteArgs.worktreeSelector,
      relativePath: remoteArgs.relativePath,
      recursive
    }),
    15_000
  )
}

export async function deleteRuntimeRelativePath(
  context: RuntimeFileOperationArgs,
  relativePath: string,
  recursive?: boolean
): Promise<boolean> {
  const target = context.target
  if (
    target.kind !== 'environment' ||
    !context.worktreeId ||
    !canReadRelativeRuntimeFile(relativePath)
  ) {
    return false
  }
  await callRuntimeFileMutation(
    target,
    'files.delete',
    withSshMutationExpectation(context, {
      worktree: toRuntimeWorktreeSelector(context.worktreeId),
      relativePath: normalizeRelativePath(relativePath),
      recursive
    }),
    15_000
  )
  return true
}
