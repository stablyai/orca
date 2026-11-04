import type { RuntimeFileOperationArgs } from './runtime-file-client-types'
import { readFloatingMarkdownTab } from './floating-markdown-client'
import {
  compareDiskWritePrecondition,
  type FileWriteDiskPrecondition,
  type FileWriteResult
} from '../../../shared/file-write-disk-precondition'

export async function writeFloatingMarkdownFile(
  context: RuntimeFileOperationArgs,
  filePath: string,
  content: string,
  precondition?: FileWriteDiskPrecondition,
  beforeSend?: () => void
): Promise<FileWriteResult> {
  const opened = await readFloatingMarkdownTab({
    target: context.target,
    worktreeId: context.worktreeId ?? undefined,
    filePath
  })
  beforeSend?.()
  if (!opened) {
    throw new Error('The remote document is no longer open on its host. Reopen it before saving.')
  }
  if (precondition) {
    const comparison = compareDiskWritePrecondition(precondition, opened.document.content, content)
    if (comparison === 'identical') {
      return { ok: true, unchanged: true }
    }
    if (comparison) {
      return { ok: false, diskConflict: comparison }
    }
  }
  await opened.save(content)
  return { ok: true }
}
