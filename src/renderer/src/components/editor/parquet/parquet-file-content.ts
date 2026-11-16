import type { RuntimeFileReadArgs } from '@/runtime/files/runtime-file-client-types'
import { readRuntimeFileContent } from '@/runtime/files/reads/runtime-file-read-client'
import { statRuntimeReadTarget } from '@/runtime/files/reads/runtime-file-range-client'
import { filePreviewExtension } from '../../../../../shared/file-preview/file-preview-kind'
import type { FileContent } from '../loading/editor-panel-content-types'

export function isParquetFilePath(filePath: string): boolean {
  return filePreviewExtension(filePath) === '.parquet'
}

/** Parquet pages its bytes by range, so a whole-file read would only hit the text size cap. */
export async function readEditorParquetFileContent(
  args: RuntimeFileReadArgs
): Promise<FileContent> {
  // Why: older hosts cannot stat a granted file, so it opens through the regular read.
  if (args.terminalArtifactGrantId) {
    return readRuntimeFileContent(args)
  }
  const snapshot = await statRuntimeReadTarget(args)
  if (snapshot.isDirectory) {
    return readRuntimeFileContent(args)
  }
  return { content: '', isBinary: true, size: snapshot.size }
}
