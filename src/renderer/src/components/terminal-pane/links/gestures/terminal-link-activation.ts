import { isMacPlatform } from '../terminal-link-open-hints'

export function isTerminalLinkActivation(
  event: Pick<MouseEvent, 'metaKey' | 'ctrlKey'> | undefined
): boolean {
  return isMacPlatform() ? Boolean(event?.metaKey) : Boolean(event?.ctrlKey)
}

type TerminalLinkMouseEvent = Pick<MouseEvent, 'ctrlKey' | 'metaKey'> &
  Partial<Pick<MouseEvent, 'altKey' | 'button' | 'shiftKey'>>

export function isTerminalLinkDirectActivation(event: TerminalLinkMouseEvent | undefined): boolean {
  return Boolean(
    event &&
    (event.button === undefined || event.button === 0) &&
    !event.altKey &&
    isTerminalLinkActivation(event)
  )
}

/** Cmd+Alt+click (Ctrl+Alt+click off macOS) opens the link in the Floating Workspace. */
export function isTerminalLinkFloatingWorkspaceActivation(
  event: TerminalLinkMouseEvent | undefined
): boolean {
  return Boolean(
    event &&
    (event.button === undefined || event.button === 0) &&
    event.altKey &&
    !event.shiftKey &&
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

export function isTerminalOwnedLinkGesture(event: TerminalLinkMouseEvent | undefined): boolean {
  return (
    isTerminalLinkDirectActivation(event) ||
    isTerminalLinkActionActivation(event) ||
    isTerminalMiddleClickActivation(event)
  )
}
