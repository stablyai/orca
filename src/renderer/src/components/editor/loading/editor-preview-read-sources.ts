import type { RuntimeFileReadArgs } from '@/runtime/files/runtime-file-client-types'
import type { FileContent } from './editor-panel-content-types'

export function withEditorPreviewReadSources(
  result: FileContent,
  source: RuntimeFileReadArgs
): FileContent {
  const servedSource = result.terminalArtifactGrantId
    ? { ...source, terminalArtifactGrantId: result.terminalArtifactGrantId }
    : source
  return {
    ...result,
    ...(result.isBinary ? { byteSource: servedSource } : {}),
    ...(result.mediaUrl && result.isImage ? { imageReadSource: servedSource } : {})
  }
}
