import type { RuntimeFileReadArgs } from '@/runtime/runtime-file-client-types'
import { readRuntimeFileContent } from '@/runtime/runtime-file-client'
import {
  statRuntimeReadTarget,
  type RuntimeFileSnapshot
} from '@/runtime/runtime-file-range-client'
import type { FileContent } from './editor-panel-content-types'

export type CsvFilePreview = { readArgs: RuntimeFileReadArgs; snapshot: RuntimeFileSnapshot }
export const CSV_PAGED_PREVIEW_BYTES = 1024 * 1024

export async function readEditorCsvFileContent(
  args: RuntimeFileReadArgs,
  allowPagedPreview = true
): Promise<FileContent> {
  if (allowPagedPreview && /\.(csv|tsv)$/i.test(args.filePath)) {
    const snapshot = await statRuntimeReadTarget(args)
    if (!snapshot.isDirectory && snapshot.size >= CSV_PAGED_PREVIEW_BYTES) {
      return { content: '', isBinary: false, csvPreview: { readArgs: args, snapshot } }
    }
  }
  return readRuntimeFileContent(args)
}
