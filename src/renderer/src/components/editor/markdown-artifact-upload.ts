import type { ArtifactWriteRequest } from '../../../../shared/artifacts'
import { basename } from '@/lib/path'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { flushPendingEditorChange } from './editor-pending-flush'

export function markdownArtifactSourceKey(file: OpenFile): string {
  const route = file.operationProvenance?.generation.route
  if (route && (route.runtimeEnvironmentId || route.executionHostId !== 'local')) {
    return JSON.stringify([
      'editor',
      route.runtimeEnvironmentId ?? null,
      route.executionHostId,
      file.filePath
    ])
  }
  if (file.runtimeEnvironmentId || file.externalSshTargetId) {
    return JSON.stringify([
      'editor',
      file.runtimeEnvironmentId ?? null,
      file.externalSshTargetId ?? 'remote',
      file.filePath
    ])
  }
  return file.filePath
}

export function createMarkdownArtifactRequest(
  file: OpenFile,
  content: string
): ArtifactWriteRequest {
  return {
    sourceKey: markdownArtifactSourceKey(file),
    content,
    contentType: 'text/markdown',
    fileName: basename(file.filePath)
  }
}

export function createCurrentMarkdownArtifactRequest(
  file: OpenFile,
  contentFileId: string,
  fallbackContent: string
): ArtifactWriteRequest {
  flushPendingEditorChange(contentFileId)
  const content = useAppStore.getState().editorDrafts[contentFileId] ?? fallbackContent
  return createMarkdownArtifactRequest(file, content)
}
