import type { LinkActionRequest } from '@/components/link-actions/link-action-request'
// Chat shares the terminal's link-click vocabulary: plain click asks, modifier click opens.
import {
  isTerminalLinkActionActivation,
  isTerminalLinkDirectActivation
} from '@/components/terminal-pane/links/gestures/terminal-link-activation'
import type { TerminalLinkClickBehavior } from '@/components/terminal-pane/links/gestures/terminal-link-click-behavior'
import {
  buildHttpLinkActions,
  httpLinkDirectClickDestination,
  openRoutedHttpLink,
  type HttpLinkActionDestinations,
  type HttpLinkDestination,
  type LinkActionContext
} from '@/lib/browser/navigation/http-link-destinations'
import type {
  HttpLinkAdmission,
  HttpLinkSourceOwner
} from '@/lib/browser/navigation/http-link-routing'
import { captureLinkActionContext } from '@/lib/links/preferences/link-action-context'
import {
  canRememberLinkChoice,
  rememberOnAdmission
} from '@/lib/links/preferences/link-remember-choice'
import type { HttpLinkMode } from '@/lib/links/preferences/http-link-mode'

export type NativeChatWebLinkDeps = {
  worktreeId: string
  sourceTabId?: string | null
  sourceOwner: HttpLinkSourceOwner
  destinations: HttpLinkActionDestinations
  /** Off: a plain click opens the routed destination outright, as it did before actions existed. */
  actionsEnabled: boolean
  plainClickBehavior?: TerminalLinkClickBehavior
  /** Chat transcripts on desktop: chooser actions keep their click capture and may offer Remember. */
  rememberHost?: { mode: HttpLinkMode }
  restoreFocus: () => void
  request: (request: LinkActionRequest) => void
}

type ChatLinkMouseEvent = Pick<
  MouseEvent,
  'altKey' | 'clientX' | 'clientY' | 'ctrlKey' | 'metaKey' | 'shiftKey'
> & {
  detail?: number
  currentTarget?: Pick<HTMLElement, 'getBoundingClientRect'>
  button?: number
  preventDefault: () => void
}

export function openNativeChatWebLink(
  url: string,
  deps: Pick<NativeChatWebLinkDeps, 'worktreeId' | 'sourceOwner' | 'sourceTabId'> & {
    actionContext?: LinkActionContext
    onAdmission?: (outcome: HttpLinkAdmission) => void
    requireOwnerHostRoute?: boolean
  },
  destination: HttpLinkDestination | undefined,
  openInSourceGroup = false
): void {
  openRoutedHttpLink(url, {
    worktreeId: deps.worktreeId,
    ...(deps.sourceTabId ? { sourceTabId: deps.sourceTabId } : {}),
    ...(openInSourceGroup ? { openInSourceGroup: true } : {}),
    sourceOwner: deps.sourceOwner,
    modifierHeld: false,
    ...(destination ? { forceDestination: destination } : {}),
    ...(deps.requireOwnerHostRoute ? { requireOwnerHostRoute: true } : {}),
    ...(deps.actionContext ? { actionContext: deps.actionContext } : {}),
    ...(deps.onAdmission ? { onAdmission: deps.onAdmission } : {})
  })
}

/** Returns true when the click was consumed; false leaves the anchor's default. */
export function handleNativeChatWebLink(
  event: ChatLinkMouseEvent,
  url: string,
  deps: NativeChatWebLinkDeps
): boolean {
  // Direct opens only; a reachable localhost link keeps its owner's route through admission.
  const open = (destination: HttpLinkDestination | undefined): void =>
    openNativeChatWebLink(
      url,
      deps.destinations.plainClick ? { ...deps, requireOwnerHostRoute: true } : deps,
      destination
    )

  if (isTerminalLinkDirectActivation(event)) {
    event.preventDefault()
    open(httpLinkDirectClickDestination(deps.destinations, event.shiftKey))
    return true
  }
  if (!isTerminalLinkActionActivation(event)) {
    return false
  }

  if (!deps.actionsEnabled) {
    if (deps.plainClickBehavior === 'none') {
      return false
    }
    event.preventDefault()
    open(deps.destinations.primary)
    return true
  }
  event.preventDefault()
  const keyboardAnchor = event.detail === 0 ? event.currentTarget?.getBoundingClientRect() : null
  const actionContext = deps.rememberHost
    ? captureLinkActionContext(deps.worktreeId, deps.sourceTabId)
    : undefined
  const chooserDeps = actionContext ? { ...deps, actionContext } : deps
  const rememberEligible = Boolean(
    deps.rememberHost &&
    actionContext &&
    canRememberLinkChoice({
      plainClick: true,
      mode: deps.rememberHost.mode,
      destinations: deps.destinations,
      actionContext
    })
  )
  deps.request({
    anchorX: keyboardAnchor?.left ?? event.clientX,
    anchorY: keyboardAnchor?.bottom ?? event.clientY,
    destination: url,
    kind: 'url',
    restoreFocus: deps.restoreFocus,
    ...(deps.rememberHost && actionContext ? { linkPreferenceHost: true, rememberEligible } : {}),
    ...buildHttpLinkActions(
      deps.destinations,
      (destination, choice) => {
        // Only an eligible chooser saves, whatever the caller passes.
        const onAdmission =
          rememberEligible && destination ? rememberOnAdmission(destination, choice) : undefined
        openNativeChatWebLink(
          url,
          { ...chooserDeps, ...(onAdmission ? { onAdmission } : {}) },
          destination
        )
      },
      {
        ...deps,
        url,
        openInSourceGroup: () => openNativeChatWebLink(url, chooserDeps, 'orca', true)
      }
    )
  })
  return true
}
