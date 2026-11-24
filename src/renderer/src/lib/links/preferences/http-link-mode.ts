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

type LinkDestinations = { primary: 'orca' | 'system'; alternate?: 'orca' | 'system' }

/** A localhost link from this machine's own process; remote loopback keeps its host's route rules. */
export function isDesktopLocalhostLink(
  url: string | undefined,
  sourceOwner: { kind: string } | undefined
): boolean {
  return (
    url !== undefined &&
    sourceOwner?.kind === 'local' &&
    usesHttpLinkMode() &&
    isLoopbackHttpUrl(url)
  )
}

/** A plain click on this link opens the Orca browser whatever the setting says. */
export function opensLocalhostInOrca(
  destinations: LinkDestinations,
  url: string,
  sourceOwner: { kind: string } | undefined
): boolean {
  return (
    (destinations.primary === 'orca' || destinations.alternate === 'orca') &&
    isDesktopLocalhostLink(url, sourceOwner)
  )
}

/** Plain and Cmd/Ctrl-click order: a local dev server opens in the Orca browser, Shift sends it out. */
export function plainClickDestinationsFor<D extends LinkDestinations>(
  destinations: D,
  url: string,
  sourceOwner: { kind: string } | undefined
): D | { primary: 'orca'; alternate: 'system' } {
  return opensLocalhostInOrca(destinations, url, sourceOwner)
    ? { primary: 'orca', alternate: 'system' }
    : destinations
}

/** One link's plain-click mode: a local localhost link that can open in Orca skips the chooser. */
export function httpLinkModeForLink(
  settings: Partial<HttpLinkModeSettings> | null | undefined,
  url: string,
  destinations: LinkDestinations,
  sourceOwner: { kind: string } | undefined
): HttpLinkMode {
  return opensLocalhostInOrca(destinations, url, sourceOwner) ? 'open' : httpLinkModeFor(settings)
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
