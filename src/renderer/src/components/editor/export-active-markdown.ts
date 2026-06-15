import { toast } from 'sonner'
import { getActiveMarkdownExportPayload } from './markdown-export-extract'
import { translate } from '@/i18n/i18n'

/**
 * Export the currently-active markdown document to PDF via the main-process
 * IPC bridge. Silent no-op when no markdown surface is active — the menu
 * item and overflow action can both share this entry point.
 */
export async function exportActiveMarkdownToPdf(): Promise<void> {
  const payload = getActiveMarkdownExportPayload()
  if (!payload) {
    // Why: design doc §5 — menu-triggered export with no markdown surface is
    // a silent no-op. The overflow-menu item is disabled in that case so we
    // only reach this branch for stray menu shortcuts.
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
