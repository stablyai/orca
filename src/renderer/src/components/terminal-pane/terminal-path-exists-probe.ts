import { runtimePathExists, type RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import {
  readTerminalPathExistsCache,
  writeTerminalPathExistsCache
} from './terminal-path-exists-cache'

export async function probeTerminalPathExists({
  absolutePath,
  cacheKey,
  fileContext,
  isRemoteRuntimePath,
  pathExistsCache
}: {
  absolutePath: string
  cacheKey: string
  fileContext: RuntimeFileOperationArgs
  isRemoteRuntimePath: boolean
  pathExistsCache: Map<string, boolean>
}): Promise<boolean> {
  const cachedExists = readTerminalPathExistsCache(pathExistsCache, cacheKey)
  if (cachedExists !== undefined) {
    return cachedExists
  }

  try {
    const exists =
      fileContext.connectionId || isRemoteRuntimePath
        ? await runtimePathExists(fileContext, absolutePath)
        : await window.api.shell.pathExists(absolutePath)
    writeTerminalPathExistsCache(pathExistsCache, cacheKey, exists)
    return exists
  } catch {
    // Why: terminal link probing is best effort. Long Windows paths and
    // disconnected SSH/runtime hosts should not become renderer rejections.
    writeTerminalPathExistsCache(pathExistsCache, cacheKey, false)
    return false
  }
}
