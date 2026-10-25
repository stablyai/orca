import { translate } from '@/i18n/i18n'
import { isPairedWebClientWindow } from './desktop-window-chrome'

/** The document preview is a desktop webview; a paired web client has no window to host it in. */
export function webClientDocPreviewRefusal(): {
  status: 'unsupported'
  message: string
  reason: 'no-channel'
} | null {
  return isPairedWebClientWindow()
    ? {
        status: 'unsupported',
        message: translate(
          'auto.lib.file.preview.webClientUnavailable',
          "Document previews aren't available in the web client."
        ),
        reason: 'no-channel'
      }
    : null
}
