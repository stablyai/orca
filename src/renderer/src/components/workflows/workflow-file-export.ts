import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

/** Native save dialog on desktop; a browser download where no native dialog exists. */
export async function saveWorkflowTextFile(
  text: string,
  suggestedName: string,
  extension: 'json' | 'csv'
): Promise<void> {
  const save = window.api.export?.saveTextFile
  if (save) {
    const result = await save({ text, suggestedName, extension })
    if (result.error) {
      toast.error(
        translate('auto.components.workflows.workflow.file.export.fc4df6fb33', 'Export failed'),
        { description: result.error }
      )
    } else if (result.saved) {
      toast.success(
        translate('auto.components.workflows.workflow.file.export.fb865bae01', 'Exported'),
        { description: result.filePath }
      )
    }
    return
  }
  const url = URL.createObjectURL(
    new Blob([text], { type: extension === 'json' ? 'application/json' : 'text/csv' })
  )
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${suggestedName}.${extension}`
  anchor.click()
  URL.revokeObjectURL(url)
}

/** Read one user-picked file as text; nothing else on disk is reachable from here. */
export function pickWorkflowTextFile(accept: string): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) {
        resolve(null)
        return
      }
      file.text().then(resolve, () => resolve(null))
    }
    input.click()
  })
}
