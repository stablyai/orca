import { getConnectionIdForFileFromState } from '@/lib/connection-owner-resolution'
import { isClientLocalReadOnlyTab } from '@/lib/local-file-access'
import { getWorkspaceFileRevealOwner } from '@/lib/reveal-in-file-manager'
import { readImageFileSource } from '@/lib/image-source-actions'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import type { FileContent } from './editor-panel-content-types'
import type { ImageActionSource } from './ImageActions'

export function useEditorImageSource(
  file: OpenFile,
  content: FileContent | undefined
): ImageActionSource {
  const owner = useAppStore((state) => {
    if (!file.externalSshTargetId && isClientLocalReadOnlyTab(file)) {
      return 'local'
    }
    const connectionId =
      file.externalSshTargetId ??
      getConnectionIdForFileFromState(state, file.worktreeId, file.filePath)
    return connectionId === undefined
      ? 'unresolved'
      : getWorkspaceFileRevealOwner(state, file.worktreeId, {
          runtimeEnvironmentId: file.runtimeEnvironmentId,
          connectionId
        })
  })
  return {
    path: file.filePath,
    ...(owner === 'local' ? { localOwner: owner } : {}),
    ...(content?.mediaUrl && content.imageReadSource
      ? {
          read: readImageFileSource(content.imageReadSource, content.mimeType)
        }
      : {})
  }
}
