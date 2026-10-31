import type { RuntimeFileReadArgs } from '@/runtime/runtime-file-client-types'
import { isSvgFilePath } from '../../../../shared/svg-document'

/** Gives a bytes custom editor the route to page the file through; an SVG opens as text but stays an image file. */
export function withEditorByteSource<T extends { isBinary?: boolean }>(
  result: T,
  readArgs: RuntimeFileReadArgs
): T | (T & { byteSource: RuntimeFileReadArgs }) {
  // Why: a grant has no ranged reads.
  if (readArgs.terminalArtifactGrantId || !(result.isBinary || isSvgFilePath(readArgs.filePath))) {
    return result
  }
  return { ...result, byteSource: readArgs }
}
