import type { RuntimeFileReadArgs } from '@/runtime/files/runtime-file-client-types'
import { readRuntimeFileContent } from '@/runtime/files/reads/runtime-file-read-client'
import {
  statRuntimeReadTarget,
  type RuntimeFileSnapshot
} from '@/runtime/files/reads/runtime-file-range-client'
import type { FileContent } from '../editor-panel-content-types'

import { CSV_PAGED_PREVIEW_BYTES } from './csv-file-limits'
export { CSV_PAGED_PREVIEW_BYTES } from './csv-file-limits'

export type CsvFilePreview = { readArgs: RuntimeFileReadArgs; snapshot: RuntimeFileSnapshot }

export async function readEditorCsvFileContent(
  args: RuntimeFileReadArgs,
  allowPagedPreview = true
): Promise<FileContent> {
  // Why: a granted file opens whole, since older hosts cannot stat it for a paged preview.
  if (allowPagedPreview && !args.terminalArtifactGrantId && /\.(csv|tsv)$/i.test(args.filePath)) {
    const snapshot = await statRuntimeReadTarget(args)
    if (!snapshot.isDirectory && snapshot.size >= CSV_PAGED_PREVIEW_BYTES) {
      return { content: '', isBinary: false, csvPreview: { readArgs: args, snapshot } }
    }
  }
  return readRuntimeFileContent(args)
}
