import type { LinkActionRequest } from '@/components/link-actions/link-action-request'
// Chat shares the terminal's link-click vocabulary: plain click asks, modifier click opens.
import {
  isTerminalLinkActionActivation,
  isTerminalLinkDirectActivation
} from '@/components/terminal-pane/terminal-link-activation'
import type { TerminalLinkClickBehavior } from '@/components/terminal-pane/terminal-link-click-behavior'
import {
  buildHttpLinkActions,
  httpLinkDirectClickDestination,
  openRoutedHttpLink,
  type HttpLinkActionDestinations,
  type HttpLinkDestination
} from '@/lib/http-link-destinations'
import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'

export type NativeChatWebLinkDeps = {
  worktreeId: string
  sourceTabId?: string | null
  sourceOwner: HttpLinkSourceOwner
  destinations: HttpLinkActionDestinations
  /** Off: a plain click opens the routed destination outright, as it did before actions existed. */
  actionsEnabled: boolean
  plainClickBehavior?: TerminalLinkClickBehavior
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
  deps: Pick<NativeChatWebLinkDeps, 'worktreeId' | 'sourceOwner' | 'sourceTabId'>,
  destination: HttpLinkDestination | undefined,
  openInSourceGroup = false
): void {
  openRoutedHttpLink(url, {
    worktreeId: deps.worktreeId,
    ...(deps.sourceTabId ? { sourceTabId: deps.sourceTabId } : {}),
    ...(openInSourceGroup ? { openInSourceGroup: true } : {}),
    sourceOwner: deps.sourceOwner,
    modifierHeld: false,
    ...(destination ? { forceDestination: destination } : {})
  })
}

/** Returns true when the click was consumed; false leaves the anchor's default. */
export function handleNativeChatWebLink(
  event: ChatLinkMouseEvent,
  url: string,
  deps: NativeChatWebLinkDeps
): boolean {
  const open = (destination: HttpLinkDestination | undefined): void =>
    openNativeChatWebLink(url, deps, destination)

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
  deps.request({
    anchorX: keyboardAnchor?.left ?? event.clientX,
    anchorY: keyboardAnchor?.bottom ?? event.clientY,
    destination: url,
    kind: 'url',
    restoreFocus: deps.restoreFocus,
    ...buildHttpLinkActions(deps.destinations, open, {
      ...deps,
      url,
      openInSourceGroup: () => openNativeChatWebLink(url, deps, 'orca', true)
    })
  })
  return true
}
