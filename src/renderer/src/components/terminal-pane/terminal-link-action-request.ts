import type { TerminalLinkPointerGesture } from './terminal-link-pointer-gesture'
import { isTerminalLinkActionActivation } from './terminal-link-activation'
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
    !isTerminalLinkActionActivation(event) ||
    !context.pointerGesture.canRequestAction(event)
  ) {
    return false
  }

  if (!context.claimPtyMouse()) {
    return false
  }
  event.preventDefault()
  context.request({
    ...details,
    paneId: context.paneId,
    anchorX: event.clientX,
    anchorY: event.clientY,
    restoreFocus: context.focusTerminal
  })
  return true
}
