import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { OpenFile } from '@/store/slices/editor'
import { dshHomeFromSessionPath } from '../../../../shared/dsh-session-paths'

export function canExportDecodedDshLog(file: OpenFile): boolean {
  return (
    file.mode === 'edit' &&
    file.readOnly === true &&
    (file.runtimeEnvironmentId ?? null) === null &&
    Boolean(dshHomeFromSessionPath(file.filePath))
  )
}

export async function exportDecodedDshLog(file: OpenFile): Promise<void> {
  if (!canExportDecodedDshLog(file)) {
    return
  }
  try {
    const result = await window.api.fs.readFile({
      filePath: file.filePath,
      ...(file.externalSshTargetId ? { connectionId: file.externalSshTargetId } : {}),
      decodeDshHistory: true
    })
    if (result.decodedDshHistory !== true || result.isBinary) {
      throw new Error(
        translate(
          'auto.components.editor.dshDecodedLogExport.updateHost',
          'Update the transcript-owning Orca host to export decoded DSH logs'
        )
      )
    }
    const name = file.filePath.split(/[\\/]/).at(-1) ?? 'session.jsonl'
    await window.api.fs.saveDownloadedFile({
      suggestedName: name.replace(/\.jsonl(?:\.zstd)?$/, '.decoded.jsonl'),
      content: result.content,
      encoding: 'utf8'
    })
  } catch (error) {
    toast.error(
      error instanceof Error
        ? error.message
        : translate(
            'auto.components.editor.dshDecodedLogExport.failed',
            'Could not export decoded DSH log'
          )
    )
  }
}
