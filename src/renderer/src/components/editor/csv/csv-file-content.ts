import type { RuntimeFileReadArgs } from '@/runtime/runtime-file-client-types'
import { readRuntimeFileContent } from '@/runtime/runtime-file-read-client'
import {
  statRuntimeReadTarget,
  type RuntimeFileSnapshot
} from '@/runtime/runtime-file-range-client'
import type { FileContent } from '../editor-panel-content-types'

import { CSV_PAGED_PREVIEW_BYTES } from './csv-file-limits'
export { CSV_PAGED_PREVIEW_BYTES } from './csv-file-limits'

export type CsvFilePreview = { readArgs: RuntimeFileReadArgs; snapshot: RuntimeFileSnapshot }

export async function readEditorCsvFileContent(
  args: RuntimeFileReadArgs,
  allowPagedPreview = true
): Promise<FileContent> {
  // Why: a granted host file has no stat route; it reads whole through its grant.
  if (allowPagedPreview && !args.terminalArtifactGrantId && /\.(csv|tsv)$/i.test(args.filePath)) {
    const snapshot = await statRuntimeReadTarget(args)
    if (!snapshot.isDirectory && snapshot.size >= CSV_PAGED_PREVIEW_BYTES) {
      return { content: '', isBinary: false, csvPreview: { readArgs: args, snapshot } }
    }
  }
  return readRuntimeFileContent(args)
}
