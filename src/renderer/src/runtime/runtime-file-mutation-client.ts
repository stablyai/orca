import type { DirEntry } from '../../../shared/filesystem-entry-types'
import { normalizeRelativePath } from '@/lib/path'
import { callRuntimeRpc, getActiveRuntimeTarget } from './runtime-rpc-client'
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

export async function readRuntimeDirectory(
  context: RuntimeFileOperationArgs,
  dirPath: string
): Promise<DirEntry[]> {
  const remoteArgs = getRemoteFileArgs(context, dirPath)
  if (!remoteArgs) {
    assertLocalFilesystemFallbackAllowed(context)
    return window.api.fs.readDir({ dirPath, connectionId: context.connectionId })
  }
  return callRuntimeRpc<DirEntry[]>(
    remoteArgs.target,
    'files.readDir',
    { worktree: remoteArgs.worktreeSelector, relativePath: remoteArgs.relativePath },
    { timeoutMs: 15_000 }
  )
}

export async function writeRuntimeFile(
  context: RuntimeFileOperationArgs,
  filePath: string,
  content: string
): Promise<void> {
  const remoteArgs = getRemoteFileArgs(context, filePath)
  if (!remoteArgs) {
    assertLocalFilesystemFallbackAllowed(context)
    await window.api.fs.writeFile(
      withSshMutationExpectation(context, { filePath, content, connectionId: context.connectionId })
    )
    return
  }
  await callRuntimeFileMutation(
    remoteArgs.target,
    'files.write',
    withSshMutationExpectation(context, {
      worktree: remoteArgs.worktreeSelector,
      relativePath: remoteArgs.relativePath,
      content
    }),
    15_000
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
  newPath: string
): Promise<void> {
  const oldRemoteArgs = getRemoteFileArgs(context, oldPath)
  const newRelativePath = getRelativePathInsideWorktree(context.worktreePath, newPath)
  if (!oldRemoteArgs || newRelativePath === null) {
    assertLocalFilesystemFallbackAllowed(context)
    await window.api.fs.rename(
      withSshMutationExpectation(context, { oldPath, newPath, connectionId: context.connectionId })
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
  recursive?: boolean
): Promise<void> {
  const remoteArgs = getRemoteFileArgs(context, targetPath)
  if (!remoteArgs) {
    assertLocalFilesystemFallbackAllowed(context)
    await window.api.fs.deletePath(
      withSshMutationExpectation(context, {
        targetPath,
        connectionId: context.connectionId,
        recursive
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
  const target = getActiveRuntimeTarget(context.settings)
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
