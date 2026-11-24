import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { terminalLinkClickBehaviorFor } from '@/components/terminal-pane/links/gestures/terminal-link-click-behavior'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { isLoopbackHttpUrl } from '../../../../../shared/workspace/ports/localhost-worktree-labels'

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

type LinkDestinations = {
  primary: 'orca' | 'system'
  alternate?: 'orca' | 'system'
  plainClick?: { primary: 'orca'; alternate: 'system' }
}

/** A localhost link whose own host's Orca browser can open it: this machine's, or an SSH host whose
 *  tab is routed through it. A "This device" fallback browses from here, so it is excluded; runtime
 *  owners keep their existing route rules. */
export function isDesktopLocalhostLink(
  url: string | undefined,
  sourceOwner: { kind: string } | undefined,
  reachesOwnerHost = false
): boolean {
  return (
    url !== undefined &&
    (sourceOwner?.kind === 'local' || (sourceOwner?.kind === 'ssh' && reachesOwnerHost)) &&
    usesHttpLinkMode() &&
    isLoopbackHttpUrl(url)
  )
}

/** Plain and Cmd/Ctrl-click order; middle-click and its chooser badges follow it only when they show it. */
export function plainClickDestinationsFor<D extends LinkDestinations>(destinations: D): D {
  // Keeps the marker, so the reordered value still reads as a localhost link that opens directly.
  return destinations.plainClick ? { ...destinations, ...destinations.plainClick } : destinations
}

/** One link's plain-click mode: a localhost link Orca can open skips the chooser. */
export function httpLinkModeForLink(
  settings: Partial<HttpLinkModeSettings> | null | undefined,
  destinations: LinkDestinations
): HttpLinkMode {
  return destinations.plainClick ? 'open' : httpLinkModeFor(settings)
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
