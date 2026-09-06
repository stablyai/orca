import type { LinkActionRequest } from '@/components/link-actions/link-action-request'
// Chat shares the terminal's link-click vocabulary: plain click asks, modifier click opens.
import {
  isTerminalLinkActionActivation,
  isTerminalLinkDirectActivation
} from '@/components/terminal-pane/terminal-link-activation'
import {
  buildHttpLinkActions,
  openRoutedHttpLink,
  type HttpLinkActionDestinations,
  type HttpLinkDestination
} from '@/lib/http-link-destinations'
import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'

export type NativeChatWebLinkDeps = {
  worktreeId: string
  sourceOwner: HttpLinkSourceOwner
  destinations: HttpLinkActionDestinations
  /** Off: a plain click opens the routed destination outright, as it did before actions existed. */
  actionsEnabled: boolean
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

/** Returns true when the click was consumed; false leaves the anchor's default. */
export function handleNativeChatWebLink(
  event: ChatLinkMouseEvent,
  url: string,
  deps: NativeChatWebLinkDeps
): boolean {
  const open = (destination: HttpLinkDestination | undefined): void =>
    openRoutedHttpLink(url, {
      worktreeId: deps.worktreeId,
      sourceOwner: deps.sourceOwner,
      modifierHeld: false,
      ...(destination ? { forceDestination: destination } : {})
    })

  if (isTerminalLinkDirectActivation(event)) {
    event.preventDefault()
    open(
      event.shiftKey
        ? (deps.destinations.alternate ?? deps.destinations.primary)
        : deps.destinations.primary
    )
    return true
  }
  if (!isTerminalLinkActionActivation(event)) {
    return false
  }

  event.preventDefault()
  if (!deps.actionsEnabled) {
    open(deps.destinations.primary)
    return true
  }
  const keyboardAnchor = event.detail === 0 ? event.currentTarget?.getBoundingClientRect() : null
  deps.request({
    anchorX: keyboardAnchor?.left ?? event.clientX,
    anchorY: keyboardAnchor?.bottom ?? event.clientY,
    destination: url,
    kind: 'url',
    restoreFocus: deps.restoreFocus,
    ...buildHttpLinkActions(deps.destinations, open)
  })
  return true
}
