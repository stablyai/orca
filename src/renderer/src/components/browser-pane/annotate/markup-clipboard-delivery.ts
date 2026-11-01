import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { MarkupComposeResult } from './markup-screenshot-compose'

// Reuse clipboard screenshot paste so image files reach the correct local/remote agent host without a separate send path.
export async function deliverMarkupToClipboard(result: MarkupComposeResult): Promise<void> {
  await window.api.ui.writeClipboardImage(result.dataUrl)
  const isMac = navigator.userAgent.includes('Mac')
  toast.success(
    translate(
      'auto.components.browser-pane.markup.copiedToast',
      'Markup copied — paste it into your agent ({{value0}})',
      { value0: isMac ? '⌘V' : 'Ctrl+V' }
    )
  )
}
