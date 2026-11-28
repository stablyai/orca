import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { BrowserPageMoveDestination, BrowserPageMoveOutcome } from './browser-page-device-move'

export function browserPageMoveLabel(
  destination: BrowserPageMoveDestination,
  hostLabel: string,
  t: Translate = translate
): string {
  return destination === 'client'
    ? t('browser.deviceMove.toThisComputer', 'Open on this computer')
    : t('browser.deviceMove.toHost', 'Open on {{host}}', { host: hostLabel })
}

export function browserPageMoveTooltip(t: Translate = translate): string {
  return t(
    'browser.deviceMove.tooltip',
    'Opens this address in a new tab on the other side and closes this one. You may need to sign in again.'
  )
}

export function browserPageMoveFailureText(
  destination: BrowserPageMoveDestination,
  t: Translate = translate
): string {
  return destination === 'client'
    ? t('browser.deviceMove.failedToThisComputer', "Couldn't open this page on this computer.")
    : t(
        'browser.reopenOnServer.failed',
        "Couldn't open this page on the remote host. Check the connection and try again."
      )
}

/** The page opened on the other side, but its old tab is still open. */
export function browserPageMoveSourceCloseFailureText(t: Translate = translate): string {
  return t(
    'browser.clientHosted.hostRowCloseFailed',
    "Couldn't close this page. The device hosting it may be busy — try again."
  )
}

/** The toast for a move that didn't finish, or null when it did. */
export function browserPageMoveOutcomeText(
  outcome: BrowserPageMoveOutcome,
  destination: BrowserPageMoveDestination
): string | null {
  return outcome === 'failed'
    ? browserPageMoveFailureText(destination)
    : outcome === 'source-close-failed'
      ? browserPageMoveSourceCloseFailureText()
      : null
}
