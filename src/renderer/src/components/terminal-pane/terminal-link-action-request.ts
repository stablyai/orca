import type { TerminalLinkPointerGesture } from './terminal-link-pointer-gesture'
import {
  prepareTerminalLinkActivation,
  commitTerminalLinkActivation,
  type TerminalLinkCommit,
  type TerminalLinkActionDetails
} from './terminal-link-activation-operation'
import type { TerminalLinkClickBehavior } from './terminal-link-click-behavior'
import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
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
  commit: TerminalLinkCommit
  request: TerminalLinkActionRequester
  focusTerminal: () => void
  plainClickBehavior?: TerminalLinkClickBehavior
  middleClickBehavior?: TerminalLinkClickBehavior
  /** The host running the pane's shell; absent reads as not this machine. */
  sourceOwner?: HttpLinkSourceOwner
}

export function closeTerminalLinkActionRequest(
  current: TerminalLinkActionRequest | null,
  dismissed?: TerminalLinkActionRequest
): TerminalLinkActionRequest | null {
  return closeLinkActionRequest(current, dismissed)
}

export function requestTerminalLinkAction(
  event: MouseEvent | undefined,
  context: TerminalLinkActionContext | null | undefined,
  details: TerminalLinkActionDetails | (() => void)
): boolean {
  return commitTerminalLinkActivation(
    event,
    prepareTerminalLinkActivation(
      event,
      {
        kind: typeof details === 'function' ? 'unresolved' : details.kind,
        details
      },
      context
    ),
    context?.commit
  )
}
