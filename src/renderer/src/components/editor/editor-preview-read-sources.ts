import type { RuntimeFileReadArgs } from '@/runtime/runtime-file-client-types'
import type { FileContent } from './editor-panel-content-types'

export function withEditorPreviewReadSources(
  result: FileContent,
  source: RuntimeFileReadArgs
): FileContent {
  return {
    ...result,
    // A grant supports whole-file image reads, but not a custom editor's ranged reads.
    ...(result.isBinary && !source.terminalArtifactGrantId ? { byteSource: source } : {}),
    ...(result.mediaUrl && result.isImage ? { imageReadSource: source } : {})
  }
}
