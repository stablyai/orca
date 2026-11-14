import { isMacPlatform } from '../terminal-link-open-hints'

export function isTerminalLinkActivation(
  event: Pick<MouseEvent, 'metaKey' | 'ctrlKey'> | undefined
): boolean {
  return isMacPlatform() ? Boolean(event?.metaKey) : Boolean(event?.ctrlKey)
}

type TerminalLinkMouseEvent = Pick<MouseEvent, 'ctrlKey' | 'metaKey'> &
  Partial<Pick<MouseEvent, 'altKey' | 'button' | 'shiftKey'>>

/** Match only the platform floating left-click chord; Shift and the other platform modifier are excluded. */
export function isTerminalLinkFloatingActivation(
  event: TerminalLinkMouseEvent | undefined
): boolean {
  return Boolean(
    event &&
    event.button === 0 &&
    event.altKey &&
    !event.shiftKey &&
    (isMacPlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
  )
}

export function isTerminalLinkDirectActivation(event: TerminalLinkMouseEvent | undefined): boolean {
  return Boolean(
    event &&
    (event.button === undefined || event.button === 0) &&
    !event.altKey &&
    isTerminalLinkActivation(event)
  )
}

export function isTerminalLinkActionActivation(event: TerminalLinkMouseEvent | undefined): boolean {
  return Boolean(
    event &&
    (event.button === undefined || event.button === 0) &&
    !event.altKey &&
    !event.shiftKey &&
    !event.metaKey &&
    !event.ctrlKey
  )
}

export function isTerminalMiddleClickActivation(
  event: TerminalLinkMouseEvent | undefined
): boolean {
  return Boolean(
    event &&
    event.button === 1 &&
    !event.altKey &&
    !event.shiftKey &&
    !event.metaKey &&
    !event.ctrlKey
  )
}

/** Identify gestures eligible for Orca link handling; hit testing still decides whether to claim them. */
export function isTerminalOwnedLinkGesture(event: TerminalLinkMouseEvent | undefined): boolean {
  return (
    isTerminalLinkFloatingActivation(event) ||
    isTerminalLinkDirectActivation(event) ||
    isTerminalLinkActionActivation(event) ||
    isTerminalMiddleClickActivation(event)
  )
}
