import { toast } from 'sonner'
import { getActiveMarkdownExportPayload } from './markdown-export-extract'
import { translate } from '@/i18n/i18n'

/**
 * Export the markdown document for a local editor panel through the existing
 * PDF bridge. Silent no-op when the panel no longer has rendered markdown.
 */
export async function exportActiveMarkdownToPdf(options: {
  fileId: string
  root: ParentNode | null
}): Promise<void> {
  const payload = getActiveMarkdownExportPayload(options)
  if (!payload) {
    // Why: stale panel refs can survive a dropdown click; keep export defensive
    // even though the local Markdown menu disables unreachable states.
    return
  }

  const toastId = toast.loading(
    translate('auto.components.editor.export.active.markdown.d4a901e0ad', 'Exporting PDF...')
  )
  try {
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
      // Why: user pressed Cancel in the save dialog — clear the loading toast
      // without surfacing an error.
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
    const message = error instanceof Error ? error.message : 'Failed to export PDF'
    toast.error(message, { id: toastId })
  }
}
