import { openHttpLink, type OpenHttpLinkOptions } from '@/lib/http-link-routing'

type ChecksPanelHostedReviewClickEvent = Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>

export function isChecksPanelHostedReviewSystemBrowserModifier(
  event: ChecksPanelHostedReviewClickEvent,
  isMac: boolean
): boolean {
  return event.shiftKey && (isMac ? event.metaKey : event.ctrlKey)
}

export function resolveChecksPanelHostedReviewHttpOpenOptions(
  event: ChecksPanelHostedReviewClickEvent,
  isMac: boolean,
  worktreeId: string | null | undefined
): OpenHttpLinkOptions {
  // Why: same escape hatch as terminal and markdown links — openHttpLink resolves
  // whether it forces the system browser or inverts the Link Routing setting.
  if (isChecksPanelHostedReviewSystemBrowserModifier(event, isMac)) {
    return { worktreeId, modifierHeld: true }
  }
  return { worktreeId }
}

/** Where a Shift+modifier click lands, or null when it lands where a plain click already does. */
export type ChecksPanelHostedReviewModifierDestination = 'system-browser' | 'orca' | null

// Why: mirrors openHttpLink's routing inputs — with inverting on and Link Routing off the
// modifier now reaches Orca here, so gating the hint on openLinksInApp alone hides a live gesture.
export function resolveChecksPanelHostedReviewModifierDestination(
  settings:
    | {
        openLinksInApp?: boolean
        openLinksInAppModifierInverts?: boolean
        activeRuntimeEnvironmentId?: string | null
      }
    | null
    | undefined,
  hasWorktree: boolean
): ChecksPanelHostedReviewModifierDestination {
  // Why: trim to match openHttpLink — an untrimmed check hides the hint on a blank
  // runtime id while the click still routes to Orca.
  if (!hasWorktree || settings?.activeRuntimeEnvironmentId?.trim()) {
    return null
  }
  if (settings?.openLinksInApp === true) {
    return 'system-browser'
  }
  return settings?.openLinksInAppModifierInverts === true ? 'orca' : null
}

export function openChecksPanelHostedReviewUrl({
  url,
  event,
  isMac,
  worktreeId
}: {
  url: string
  event: ChecksPanelHostedReviewClickEvent
  isMac: boolean
  worktreeId: string | null | undefined
}): void {
  openHttpLink(url, resolveChecksPanelHostedReviewHttpOpenOptions(event, isMac, worktreeId))
}
