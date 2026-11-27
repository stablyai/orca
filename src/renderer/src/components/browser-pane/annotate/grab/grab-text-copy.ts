import type { BrowserGrabPayload } from '../../../../../../shared/browser/element-grab/browser-grab-types'
import type { ShowGrabToast } from '../../describe-page/browser-page-types'
import { formatGrabPayloadAsText } from './GrabConfirmationSheet'
import { copiedGrabToastMessage, copyFailedGrabToastMessage } from './grab-toast-messages'

/** Copies a pick's text; Copied shows only once the clipboard has it. */
export function copyGrabPayloadText(
  payload: BrowserGrabPayload,
  showGrabToast: ShowGrabToast,
  copiedMessage: string = copiedGrabToastMessage()
): void {
  void window.api.ui.writeClipboardText(formatGrabPayloadAsText(payload)).then(
    () => showGrabToast(copiedMessage, 'success', payload, true),
    () => showGrabToast(copyFailedGrabToastMessage(), 'error', payload)
  )
}
