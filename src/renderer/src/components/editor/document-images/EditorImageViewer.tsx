import type { ComponentProps } from 'react'
import ImageViewer from './ImageViewer'
import { getConnectionIdForFileFromState } from '@/lib/workspace/ownership/connection-owner-resolution'
import { isClientLocalReadOnlyTab } from '@/lib/files/access/local-file-access'
import { getWorkspaceFileRevealOwner } from '@/lib/files/os-open/reveal-in-file-manager'
import { readImageFileSource } from '@/lib/image-source-actions'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { FileContent } from '../loading/editor-panel-content-types'
import type { ImageActionSource } from './ImageActions'

type Props = Omit<
  ComponentProps<typeof ImageViewer>,
  'content' | 'src' | 'byteSize' | 'filePath' | 'imageSource'
> & { file: OpenFile; content?: FileContent }

export default function EditorImageViewer({ file, content, ...props }: Props): React.JSX.Element {
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
  const imageSource: ImageActionSource = {
    path: file.filePath,
    ...(owner === 'local' ? { localOwner: owner } : {}),
    ...(content?.mediaUrl && content.imageReadSource
      ? {
          read: readImageFileSource(content.imageReadSource, content.mimeType)
        }
      : {})
  }
  return (
    <ImageViewer
      {...props}
      content={content?.content}
      src={content?.mediaUrl}
      byteSize={content?.size}
      filePath={file.filePath}
      imageSource={imageSource}
    />
  )
}
