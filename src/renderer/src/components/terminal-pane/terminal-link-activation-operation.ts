import type {
  TerminalLinkActionContext,
  TerminalLinkActionRequest
} from './terminal-link-action-request'
import {
  isTerminalLinkActionActivation,
  isTerminalLinkContextMenuActivation,
  isTerminalMiddleClickActivation
} from './terminal-link-activation'

export type TerminalLinkOperation = {
  kind: TerminalLinkActionRequest['kind'] | 'unresolved'
  run: () => void
}
export type TerminalLinkCommit = (event: MouseEvent, operation: TerminalLinkOperation) => boolean
export type TerminalLinkActionDetails = Pick<
  TerminalLinkActionRequest,
  'destination' | 'copyValue' | 'kind' | 'primary' | 'alternate' | 'secondaryActions'
>

/** Resolve caller policy without reserving an open, probing a host or running an effect. */
export function prepareTerminalLinkActivation(
  event: MouseEvent | undefined,
  target: {
    kind: TerminalLinkOperation['kind']
    direct?: () => void
    details: TerminalLinkActionDetails | (() => void)
  },
  context?: TerminalLinkActionContext | null
): TerminalLinkOperation | null {
  if (!event) {
    return null
  }
  if (target.direct) {
    return { kind: target.kind, run: target.direct }
  }
  if (!context) {
    return null
  }
  const menu = isTerminalLinkContextMenuActivation(event)
  const middle = isTerminalMiddleClickActivation(event)
  const mode = middle ? (context.middleClickBehavior ?? 'open') : context.plainClickBehavior
  if (
    !(menu || ((isTerminalLinkActionActivation(event) || middle) && mode !== 'none')) ||
    (!menu && !context.pointerGesture.canRequestAction(event)) ||
    (middle && !menu && mode !== 'open' && mode !== 'actions')
  ) {
    return null
  }
  const details = target.details
  if (typeof details === 'function') {
    return { kind: target.kind, run: details }
  }
  const run =
    !menu && mode === 'open'
      ? () => {
          context.focusTerminal()
          details.primary?.run()
        }
      : () =>
          context.request({
            ...details,
            paneId: context.paneId,
            anchorX: event.clientX,
            anchorY: event.clientY,
            restoreFocus: context.focusTerminal
          })
  return { kind: target.kind, run }
}

export function commitTerminalLinkActivation(
  event: MouseEvent | undefined,
  operation: TerminalLinkOperation | null,
  commit: TerminalLinkCommit | null | undefined
): boolean {
  return Boolean(event && operation && commit?.(event, operation))
}
