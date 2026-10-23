import { showOpenInGroupRefusedToast } from '@/components/terminal-pane/terminal-file-open-in-group-toast'
import { beginLinkOpenRequest } from './link-open-request'
import { translate } from '@/i18n/i18n'
import {
  openHttpLink,
  captureHttpLinkIntent,
  canHttpLinkOpenInSourceGroup,
  type HttpLinkSourceOwner
} from '@/lib/http-link-routing'

// Catalog keys keep their original terminal namespace: they are opaque ids with
// shipped translations, and the popover is now shared with native chat.

export type HttpLinkDestination = 'orca' | 'system'

export type HttpLinkActionDestinations = {
  primary: HttpLinkDestination
  alternate?: HttpLinkDestination
}

export type HttpLinkAction = {
  external?: boolean
  label: string
  run: () => void | Promise<void>
}

export function canSourceOwnerOpenInOrca(
  sourceOwner: HttpLinkSourceOwner,
  canOpenOwnedBrowser: boolean
): boolean {
  return (
    sourceOwner.kind === 'local' ||
    ((sourceOwner.kind === 'runtime' || sourceOwner.kind === 'ssh') && canOpenOwnedBrowser)
  )
}

/** Which destinations a clicked link offers, primary first; a remote source that
 *  cannot reach Orca's managed browser offers only the system browser. */
export function httpLinkActionDestinationsFor(
  settings: { openLinksInApp?: boolean } | null | undefined,
  sourceOwner: HttpLinkSourceOwner,
  canOpenOwnedBrowser: boolean
): HttpLinkActionDestinations {
  if (!canSourceOwnerOpenInOrca(sourceOwner, canOpenOwnedBrowser)) {
    return { primary: 'system' }
  }
  return settings?.openLinksInApp === true
    ? { primary: 'orca', alternate: 'system' }
    : { primary: 'system', alternate: 'orca' }
}

/** A modifier click opens the primary destination; Shift takes the other one. */
export function httpLinkDirectClickDestination(
  destinations: HttpLinkActionDestinations,
  shiftKey: boolean
): HttpLinkDestination {
  return shiftKey ? (destinations.alternate ?? destinations.primary) : destinations.primary
}

export function httpLinkDestinationLabel(destination: HttpLinkDestination): string {
  return destination === 'orca'
    ? translate(
        'auto.components.terminal.pane.TerminalLinkActionPopover.orcaBrowser',
        'Orca Browser'
      )
    : translate(
        'auto.components.terminal.pane.TerminalLinkActionPopover.systemBrowser',
        'System Browser'
      )
}

/** One action per offered destination; surfaces share the labels and the open call. */
export function buildHttpLinkActions(
  destinations: HttpLinkActionDestinations | undefined,
  open: (destination: HttpLinkDestination | undefined) => void | Promise<void>,
  source?: {
    worktreeId: string
    url?: string
    sourceOwner?: HttpLinkSourceOwner
    sourceTabId?: string | null
    openInSourceGroup: () => void | Promise<void>
  }
): { primary: HttpLinkAction; alternate?: HttpLinkAction; secondaryActions?: HttpLinkAction[] } {
  const primaryDestination = destinations?.primary
  const primary: HttpLinkAction = {
    external: primaryDestination === 'system',
    label: primaryDestination
      ? httpLinkDestinationLabel(primaryDestination)
      : translate('auto.components.terminal.pane.TerminalLinkActionPopover.openLink', 'Open link'),
    run: () => open(primaryDestination)
  }
  const secondaryActions =
    source &&
    (destinations?.primary === 'orca' || destinations?.alternate === 'orca') &&
    canHttpLinkOpenInSourceGroup(
      source.worktreeId,
      source.sourceTabId,
      source.url,
      source.sourceOwner
    )
      ? [
          {
            label: translate(
              'auto.components.terminal.pane.TerminalLinkActionPopover.openInThisGroup',
              'Open in this group'
            ),
            run: source.openInSourceGroup
          }
        ]
      : undefined
  const alternateDestination = destinations?.alternate
  if (!alternateDestination) {
    return { primary, ...(secondaryActions ? { secondaryActions } : {}) }
  }
  return {
    primary,
    ...(secondaryActions ? { secondaryActions } : {}),
    alternate: {
      external: alternateDestination === 'system',
      label: httpLinkDestinationLabel(alternateDestination),
      run: () => open(alternateDestination)
    }
  }
}

export type HttpLinkRoutingPreferenceRequester = (
  url: string
) => boolean | Promise<boolean> | null | undefined

export type RoutedHttpLinkOptions = {
  worktreeId: string
  sourceTabId?: string | null
  openInSourceGroup?: boolean
  sourceOwner?: HttpLinkSourceOwner
  modifierHeld?: boolean
  forceDestination?: HttpLinkDestination
  requestOpenLinksInAppPreference?: HttpLinkRoutingPreferenceRequester
}

export function openRoutedHttpLink(url: string, deps: RoutedHttpLinkOptions): void {
  const isCurrentRequest = beginLinkOpenRequest()
  const linkIntent = captureHttpLinkIntent(
    deps.worktreeId,
    deps.sourceTabId,
    deps.openInSourceGroup
  )
  if (deps.openInSourceGroup && !linkIntent) {
    showOpenInGroupRefusedToast(url)
    return
  }
  const linkContext = deps.sourceTabId ? { linkIntent, isCurrentRequest } : undefined
  // Why: the clicked link's owner beats the global active runtime for both local and remote routes.
  const sourceOwner = deps.sourceOwner ?? { kind: 'local' }
  if (deps.forceDestination) {
    openHttpLink(url, {
      ...(linkContext ? { linkContext } : {}),
      allowRemoteInApp: true,
      worktreeId: deps.worktreeId,
      forceInApp: deps.forceDestination === 'orca',
      forceSystemBrowser: deps.forceDestination === 'system',
      sourceOwner
    })
    return
  }
  if (deps.modifierHeld) {
    // Why: the modifier states a destination outright, so it also skips the
    // one-time routing prompt; openHttpLink resolves which destination it means.
    openHttpLink(url, {
      ...(linkContext ? { linkContext } : {}),
      allowRemoteInApp: true,
      worktreeId: deps.worktreeId,
      modifierHeld: true,
      sourceOwner
    })
    return
  }

  // Why: remote sources use the persisted routing preference and never prompt the viewing client.
  const preferenceDecision =
    sourceOwner.kind === 'local' ? deps.requestOpenLinksInAppPreference?.(url) : null
  if (preferenceDecision === null || preferenceDecision === undefined) {
    openHttpLink(url, {
      ...(linkContext ? { linkContext } : {}),
      allowRemoteInApp: true,
      worktreeId: deps.worktreeId,
      sourceOwner
    })
    return
  }

  // Why: the first link click may need an async preference dialog.
  // Suppress the browser's default link handling first, then route after the
  // persisted choice is available.
  void Promise.resolve(preferenceDecision)
    .then((openInOrca) => {
      openHttpLink(url, {
        ...(linkContext ? { linkContext } : {}),
        allowRemoteInApp: true,
        worktreeId: deps.worktreeId,
        forceSystemBrowser: !openInOrca,
        sourceOwner
      })
    })
    .catch(() => {
      openHttpLink(url, {
        ...(linkContext ? { linkContext } : {}),
        allowRemoteInApp: true,
        worktreeId: deps.worktreeId,
        forceSystemBrowser: true,
        sourceOwner
      })
    })
}
