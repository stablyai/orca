import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { terminalLinkClickBehaviorFor } from '@/components/terminal-pane/links/gestures/terminal-link-click-behavior'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'

export type HttpLinkMode = 'ask' | 'open'

type HttpLinkModeSettings = Pick<
  GlobalSettings,
  'httpLinkClickBehavior' | 'terminalLinkClickBehavior' | 'terminalLinkActionPopoverEnabled'
>

/** Desktop plain-click mode for HTTP links; a missing or invalid value falls back to the terminal choice. */
export function httpLinkModeFor(
  settings: Partial<HttpLinkModeSettings> | null | undefined
): HttpLinkMode {
  const stored = settings?.httpLinkClickBehavior
  if (stored === 'ask' || stored === 'open') {
    return stored
  }
  return terminalLinkClickBehaviorFor(settings) === 'actions' ? 'ask' : 'open'
}

/** The web client keeps its own resolvers and has no Remember row or new mode. */
export function usesHttpLinkMode(): boolean {
  return !isWebClientLocation()
}

/** Settings a Remember choice writes: the browser, the open mode, and no legacy first-use prompt. */
export function rememberedLinkFields(destination: 'orca' | 'system'): {
  openLinksInApp: boolean
  httpLinkClickBehavior: 'open'
  openLinksInAppPreferencePrompted: true
} {
  return {
    openLinksInApp: destination === 'orca',
    httpLinkClickBehavior: 'open',
    openLinksInAppPreferencePrompted: true
  }
}
