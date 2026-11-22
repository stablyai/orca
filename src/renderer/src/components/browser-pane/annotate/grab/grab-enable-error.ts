import type { BrowserGrabRejectReason } from '../../../../../../shared/browser/element-grab/browser-grab-types'
import { translate } from '@/i18n/i18n'

export function getGrabEnableError(reason: BrowserGrabRejectReason): string {
  switch (reason) {
    case 'not-ready':
      return translate(
        'auto.components.browser-pane.grab.errorNotReady',
        "This page isn't ready for element selection yet."
      )
    case 'not-authorized':
      return translate(
        'auto.components.browser-pane.grab.errorNotAuthorized',
        'Browser access was denied.'
      )
    case 'already-active':
      return translate(
        'auto.components.browser-pane.grab.errorAlreadyActive',
        'Element selection is already active.'
      )
    case 'injection-failed':
      return translate(
        'auto.components.browser-pane.grab.errorInjectionFailed',
        'Could not start element selection on this page.'
      )
  }
}
