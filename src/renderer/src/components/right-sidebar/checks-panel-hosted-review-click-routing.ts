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
  // Use openHttpLink's shared modifier policy for system-browser escape or routing inversion.
  if (isChecksPanelHostedReviewSystemBrowserModifier(event, isMac)) {
    return { worktreeId, allowRemoteInApp: true, modifierHeld: true }
  }
  return { worktreeId, allowRemoteInApp: true }
}

/** Where a Shift+modifier click lands, or null when it lands where a plain click already does. */
export type ChecksPanelHostedReviewModifierDestination = 'system-browser' | 'orca' | null

// Mirror routing inputs so inverted modifiers reaching Orca still get a discoverable hint.
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
  if (!hasWorktree) {
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
