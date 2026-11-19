import type { TerminalLinkPointerGesture } from './gestures/terminal-link-pointer-gesture'
import {
  isTerminalLinkActionActivation,
  isTerminalMiddleClickActivation
} from './gestures/terminal-link-activation'
import type { TerminalLinkClickBehavior } from './gestures/terminal-link-click-behavior'
import type { HttpLinkSourceOwner } from '@/lib/browser/navigation/http-link-routing'
import type { LinkActionRequest } from '@/components/link-actions/link-action-request'
import type { HttpLinkMode } from '@/lib/links/preferences/http-link-mode'

export type TerminalLinkActionRequest = LinkActionRequest & { paneId: number }

export type TerminalLinkActionRequester = (request: TerminalLinkActionRequest) => void

export type TerminalLinkActionContext = {
  paneId: number
  pointerGesture: TerminalLinkPointerGesture
  claimPtyMouse: () => boolean
  request: TerminalLinkActionRequester
  focusTerminal: () => void
  plainClickBehavior?: TerminalLinkClickBehavior
  /** HTTP URLs on desktop follow the link mode; file links keep plainClickBehavior. */
  httpPlainClickBehavior?: TerminalLinkClickBehavior
  /** Desktop only: URL choosers here may offer "Always open links this way". */
  rememberMode?: HttpLinkMode
  middleClickBehavior?: TerminalLinkClickBehavior
  /** The host running the pane's shell; absent reads as not this machine. */
  sourceOwner?: HttpLinkSourceOwner
}

type LinkActionDetails = Pick<
  TerminalLinkActionRequest,
  | 'destination'
  | 'copyValue'
  | 'kind'
  | 'primary'
  | 'alternate'
  | 'secondaryActions'
  | 'rememberEligible'
  | 'linkPreferenceHost'
>

function plainBehaviorFor(
  context: TerminalLinkActionContext,
  kind: LinkActionDetails['kind']
): TerminalLinkClickBehavior | undefined {
  return kind === 'url' && context.httpPlainClickBehavior
    ? context.httpPlainClickBehavior
    : context.plainClickBehavior
}

export function requestTerminalLinkAction(
  event: MouseEvent | undefined,
  context: TerminalLinkActionContext | null | undefined,
  details: LinkActionDetails
): boolean {
  if (
    !event ||
    !context ||
    !(
      (isTerminalLinkActionActivation(event) &&
        plainBehaviorFor(context, details.kind) !== 'none') ||
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
  if (
    (middleClick ? context.middleClickBehavior : plainBehaviorFor(context, details.kind)) === 'open'
  ) {
    context.focusTerminal()
    details.primary?.run()
    return true
  }
  if (middleClick && context.middleClickBehavior !== 'actions') {
    return false
  }
  context.request({
    ...details,
    // Remember only on a plain-click chooser; middle-click choosers never save.
    rememberEligible: !middleClick && details.rememberEligible === true,
    paneId: context.paneId,
    anchorX: event.clientX,
    anchorY: event.clientY,
    restoreFocus: context.focusTerminal
  })
  return true
}
