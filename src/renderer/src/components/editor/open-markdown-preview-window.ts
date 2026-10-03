import { toast } from 'sonner'
import { getActiveMarkdownExportPayload } from './markdown-export-extract'
import { translate } from '@/i18n/i18n'

export async function openActiveMarkdownPreviewWindow(options: {
  fileId: string
  root: ParentNode | null
}): Promise<void> {
  try {
    const payload = await getActiveMarkdownExportPayload(options)
    if (!payload) {
      toast.error(
        translate('documentPreview.noRenderedContent', 'Open the rendered preview first.')
      )
      return
    }
    await window.api.docPreview.openMarkdownWindow({ ...payload, fileId: options.fileId })
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Unable to open preview window')
  }
}
