import type { ImageActionSource } from '@/components/editor/ImageActions'
import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'

export function nativeChatImageActionSource(
  path: string,
  runtimeContext: RuntimeFileOperationArgs | null | undefined
): ImageActionSource {
  return {
    path,
    ...(runtimeContext?.target.kind === 'local' &&
    !runtimeContext.connectionId &&
    !runtimeContext.expectedExternalSshTargetId &&
    (!runtimeContext.expectedExecutionHostId || runtimeContext.expectedExecutionHostId === 'local')
      ? { localOwner: 'local' as const }
      : {})
  }
}
