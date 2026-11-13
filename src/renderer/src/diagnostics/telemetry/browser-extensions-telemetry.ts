import type { EventProps } from '../../../../shared/telemetry-events'
import { track } from './telemetry'

export function trackBrowserExtensionsBannerAction(
  action: EventProps<'browser_extensions_banner_action'>['action']
): void {
  track('browser_extensions_banner_action', { action })
}

export function trackBrowserExtensionsWebStoreOpened(
  source: EventProps<'browser_extensions_web_store_opened'>['source']
): void {
  track('browser_extensions_web_store_opened', { source })
}
