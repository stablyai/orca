import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import { readRuntimeFilePreview } from '@/runtime/runtime-file-client'

export function readLocalImagePreview(
  absolutePath: string,
  connectionId?: string | null,
  runtimeContext?: Omit<RuntimeFileOperationArgs, 'connectionId'> & { connectionId?: string | null }
) {
  try {
    if (!runtimeContext) {
      return window.api.fs.readFile({
        filePath: absolutePath,
        connectionId: connectionId ?? undefined
      })
    }
    return readRuntimeFilePreview(
      { ...runtimeContext, connectionId: runtimeContext.connectionId ?? connectionId ?? undefined },
      absolutePath
    )
  } catch (error) {
    return Promise.reject(error)
  }
}
