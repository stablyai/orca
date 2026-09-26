import type { TerminalLinkPointerGesture } from './terminal-link-pointer-gesture'
import {
  isTerminalLinkActionActivation,
  isTerminalMiddleClickActivation
} from './terminal-link-activation'
import type { TerminalLinkClickBehavior } from './terminal-link-click-behavior'
import {
  closeLinkActionRequest,
  type LinkAction,
  type LinkActionKind,
  type LinkActionRequest
} from '@/components/link-actions/link-action-request'

export type TerminalLinkActionKind = LinkActionKind

export type TerminalLinkAction = LinkAction

export type TerminalLinkActionRequest = LinkActionRequest & { paneId: number }

export type TerminalLinkActionRequester = (request: TerminalLinkActionRequest) => void

export type TerminalLinkActionContext = {
  paneId: number
  pointerGesture: TerminalLinkPointerGesture
  claimPtyMouse: () => boolean
  request: TerminalLinkActionRequester
  focusTerminal: () => void
  plainClickBehavior?: TerminalLinkClickBehavior
  middleClickBehavior?: TerminalLinkClickBehavior
}

export function closeTerminalLinkActionRequest(
  current: TerminalLinkActionRequest | null,
  dismissed?: TerminalLinkActionRequest
): TerminalLinkActionRequest | null {
  return closeLinkActionRequest(current, dismissed)
}

type LinkActionDetails = Pick<
  TerminalLinkActionRequest,
  'destination' | 'kind' | 'primary' | 'alternate'
>

export function requestTerminalLinkAction(
  event: MouseEvent | undefined,
  context: TerminalLinkActionContext | null | undefined,
  details: LinkActionDetails
): boolean {
  if (
    !event ||
    !context ||
    !(
      isTerminalLinkActionActivation(event) ||
      (isTerminalMiddleClickActivation(event) && context.middleClickBehavior !== 'none')
    ) ||
    !context.pointerGesture.canRequestAction(event)
  ) {
    return false
  }

  if (!context.claimPtyMouse()) {
    return false
  }
  event.preventDefault()
  const middleClick = isTerminalMiddleClickActivation(event)
  if ((middleClick ? context.middleClickBehavior : context.plainClickBehavior) === 'open') {
    context.focusTerminal()
    details.primary?.run()
    return true
  }
  if (middleClick && context.middleClickBehavior !== 'actions') {
    return false
  }
  context.request({
    ...details,
    paneId: context.paneId,
    anchorX: event.clientX,
    anchorY: event.clientY,
    restoreFocus: context.focusTerminal
  })
  return true
}
