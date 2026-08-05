import { isRemoteRuntimeFileOperation, runtimePathExists } from '@/runtime/runtime-file-client'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import {
  getTerminalPathExistsCacheKey,
  readTerminalPathExistsCache,
  writeTerminalPathExistsCache
} from './terminal-path-exists-cache'
import {
  lookupWorktreeListedPathExists,
  terminalWorktreePathIndexOwnerKey
} from './terminal-worktree-path-index'

// Why: hover linkify used to await shell:pathExists per candidate (#11975).
// Order: pathExistsCache → positive-only worktree listing → IPC/stat.
export async function resolveTerminalFilePathExists(args: {
  mappedPath: string
  worktreeId: string
  worktreePath: string
  fileContext: RuntimeFileOperationArgs
  runtimeEnvironmentId?: string | null
  pathExistsCache: Map<string, boolean>
  pathIndexOwnerKey?: string | null
}): Promise<boolean> {
  const {
    mappedPath,
    worktreeId,
    worktreePath,
    fileContext,
    runtimeEnvironmentId,
    pathExistsCache,
    pathIndexOwnerKey
  } = args
  const isRemoteRuntimePath = isRemoteRuntimeFileOperation(fileContext, mappedPath)
  const cacheKey = getTerminalPathExistsCacheKey({
    absolutePath: mappedPath,
    connectionId: fileContext.connectionId,
    isRemoteRuntimePath,
    runtimeEnvironmentId
  })
  const cachedExists = readTerminalPathExistsCache(pathExistsCache, cacheKey)
  const ownerKey =
    pathIndexOwnerKey?.trim() ||
    terminalWorktreePathIndexOwnerKey({
      connectionId: fileContext.connectionId,
      runtimeEnvironmentId
    })
  const listedExists = lookupWorktreeListedPathExists(
    worktreeId,
    worktreePath,
    mappedPath,
    ownerKey
  )
  const exists =
    cachedExists ??
    listedExists ??
    (fileContext.connectionId || isRemoteRuntimePath
      ? await runtimePathExists(fileContext, mappedPath)
      : await window.api.shell.pathExists(mappedPath))
  writeTerminalPathExistsCache(pathExistsCache, cacheKey, exists)
  return exists
}
