import type { ArtifactWriteRequest } from '../../../../shared/artifacts'
import { fileArtifactSourceKey, type FileArtifactOwner } from '@/lib/file-artifact-source-key'
import { basename } from '@/lib/path'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { flushPendingEditorBuffer } from './editor-pending-flush'

export type ShareableFileContentType = ArtifactWriteRequest['contentType']

/** Use captured file ownership; legacy tabs without routes retain their recorded runtime environment. */
function editorArtifactOwner(file: OpenFile): FileArtifactOwner {
  const route = file.operationProvenance?.generation.route
  return {
    executionHostId: route?.executionHostId ?? null,
    runtimeEnvironmentId: route ? route.runtimeEnvironmentId : (file.runtimeEnvironmentId ?? null),
    externalSshTargetId: file.externalSshTargetId
  }
}

export function editorArtifactSourceKey(file: OpenFile): string {
  return fileArtifactSourceKey(editorArtifactOwner(file), file.filePath)
}

export function editorArtifactContentType(
  filePath: string,
  isMarkdown: boolean
): ShareableFileContentType | null {
  if (isMarkdown) {
    return 'text/markdown'
  }
  return isShareableHtmlPath(filePath) ? 'text/html' : null
}

export function isShareableHtmlPath(filePath: string): boolean {
  return /\.html?$/i.test(filePath)
}

export function createEditorArtifactRequest(
  file: OpenFile,
  content: string,
  contentType: ShareableFileContentType
): ArtifactWriteRequest {
  return {
    sourceKey: editorArtifactSourceKey(file),
    content,
    contentType,
    fileName: basename(file.filePath)
  }
}

export function createCurrentEditorArtifactRequest(
  file: OpenFile,
  contentFileId: string,
  fallbackContent: string,
  contentType: ShareableFileContentType
): ArtifactWriteRequest {
  flushPendingEditorBuffer(useAppStore.getState(), contentFileId)
  const content = useAppStore.getState().editorDrafts[contentFileId] ?? fallbackContent
  return createEditorArtifactRequest(file, content, contentType)
}
