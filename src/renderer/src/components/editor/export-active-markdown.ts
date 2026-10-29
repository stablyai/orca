import { toast } from 'sonner'
import { getActiveMarkdownExportPayload } from './markdown-export-extract'
import { translate } from '@/i18n/i18n'

/** Export the panel’s rendered Markdown through the PDF bridge; stale or source-only panels no-op. */
export async function exportActiveMarkdownToPdf(options: {
  fileId: string
  root: ParentNode | null
}): Promise<void> {
  const toastId = toast.loading(
    translate('auto.components.editor.export.active.markdown.d4a901e0ad', 'Exporting PDF...')
  )
  try {
    const payload = await getActiveMarkdownExportPayload(options)
    if (!payload) {
      // Dropdown clicks can outlive the rendered panel.
      toast.dismiss(toastId)
      return
    }

    const result = await window.api.export.htmlToPdf({
      html: payload.html,
      title: payload.title
    })
    if (result.success) {
      toast.success(
        translate(
          'auto.components.editor.export.active.markdown.51c4244904',
          'Exported to {{value0}}',
          { value0: result.filePath }
        ),
        { id: toastId }
      )
      return
    }
    if (result.cancelled) {
      toast.dismiss(toastId)
      return
    }
    toast.error(
      result.error ??
        translate(
          'auto.components.editor.export.active.markdown.eda2cea3ad',
          'Failed to export PDF'
        ),
      { id: toastId }
    )
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : translate(
            'auto.components.editor.export.active.markdown.eda2cea3ad',
            'Failed to export PDF'
          )
    toast.error(message, { id: toastId })
  }
}
