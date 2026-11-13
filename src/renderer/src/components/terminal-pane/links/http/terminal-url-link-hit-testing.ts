import type { IBufferLine, IDisposable, Terminal } from '@xterm/xterm'
import type { HttpLinkSourceOwner } from '@/lib/browser/navigation/http-link-routing'
import {
  isTerminalLinkDirectActivation as isTerminalHttpLinkActivation,
  isTerminalLinkFloatingActivation,
  isTerminalOwnedLinkGesture
} from '../gestures/terminal-link-activation'
import {
  installTerminalLinkPtyMouseSuppression,
  type TerminalLinkPtyMouseSuppression
} from '../gestures/terminal-link-pty-mouse-suppression'
import { getTerminalBufferPositionForMouseEvent } from '../../input/pointer/terminal-mouse-buffer-position'
import { findTerminalHttpLinkAtBufferPosition } from '../../../../../../shared/terminal/links/terminal-link-buffer-hit-testing'
import {
  isTerminalLinkifierHoverActive,
  isTerminalLinkifierHoverAtMouseEvent
} from '@/lib/pane-manager/terminal-input/terminal-linkifier-hover-reset'
import {
  buildHttpLinkActions,
  httpLinkDirectClickDestination,
  openRoutedHttpLink,
  type HttpLinkActionDestinations,
  type HttpLinkDestination,
  type HttpLinkRoutingPreferenceRequester
} from '@/lib/browser/navigation/http-link-destinations'
import {
  requestTerminalLinkAction,
  claimTerminalFloatingLink,
  type TerminalLinkActionContext
} from '../terminal-link-action-request'

type UrlLinkHitTestDeps = {
  worktreeId: string
  sourceTabId?: string | null
  sourceOwner?: HttpLinkSourceOwner
  modifierHeld?: boolean
  requestOpenLinksInAppPreference?: HttpLinkRoutingPreferenceRequester
  linkActionContext?: TerminalLinkActionContext | null
  actionDestinations?: HttpLinkActionDestinations
  actionDestination?: string
  forceDestination?: HttpLinkDestination
}

type UrlLinkClickFallbackDeps = {
  worktreeId: string
  sourceTabId?: string | null
  /** Resolved per click: the pane's PTY (and its runtime binding) may not exist at install time. */
  getSourceOwner?: () => HttpLinkSourceOwner
  requestOpenLinksInAppPreference?: HttpLinkRoutingPreferenceRequester
  getLinkActionContext?: (event?: MouseEvent) => TerminalLinkActionContext | null
  getActionDestinations?: () => HttpLinkActionDestinations
  isValidatedFileLink?: (event: MouseEvent) => boolean
}

export type HttpLinkClickFallbackBinding = IDisposable & {
  ptyMouseSuppression: TerminalLinkPtyMouseSuppression
}

/** Allow desktop fallback only for gestures eligible for an Orca HTTP link action. */
function isDesktopHttpLinkFallbackActivation(event: MouseEvent): boolean {
  if (event.defaultPrevented || (event.button !== 0 && event.button !== 1)) {
    return false
  }
  // Shift-only and unowned Alt chords remain available to the terminal or child TUI.
  return isTerminalOwnedLinkGesture(event)
}

/** Route a validated HTTP link through its source owner, claiming the floating chord once. */
export function handleTerminalHttpLink(
  url: string,
  event: MouseEvent | undefined,
  deps: UrlLinkHitTestDeps
): boolean {
  if (isTerminalLinkFloatingActivation(event)) {
    if (!claimTerminalFloatingLink(event, deps.linkActionContext)) {
      return false
    }
    openRoutedHttpLink(url, { ...deps, floatingWorkspace: true, forceDestination: 'orca' })
    return true
  }
  if (isTerminalHttpLinkActivation(event)) {
    const forceDestination =
      deps.actionDestinations &&
      httpLinkDirectClickDestination(deps.actionDestinations, Boolean(event?.shiftKey))
    openRoutedHttpLink(url, {
      ...deps,
      modifierHeld: forceDestination ? false : Boolean(event?.shiftKey),
      forceDestination
    })
    return true
  }

  return requestTerminalLinkAction(event, deps.linkActionContext, {
    destination: deps.actionDestination ?? url,
    kind: 'url',
    ...buildHttpLinkActions(
      deps.actionDestinations,
      (destination) =>
        openRoutedHttpLink(url, { ...deps, modifierHeld: false, forceDestination: destination }),
      {
        ...deps,
        url,
        openInSourceGroup: () =>
          openRoutedHttpLink(url, { ...deps, forceDestination: 'orca', openInSourceGroup: true })
      }
    )
  })
}

export function openHttpLinkAtTerminalMouseEvent(
  terminal: Terminal,
  event: MouseEvent,
  deps: UrlLinkHitTestDeps
): boolean {
  if (event.button !== 0 || !isTerminalHttpLinkActivation(event)) {
    return false
  }
  const position = getTerminalBufferPositionForMouseEvent(terminal, event)
  if (!position) {
    return false
  }
  return openHttpLinkAtBufferPosition(terminal.buffer.active, position, terminal.cols, deps)
}

export function findHttpLinkAtTerminalMouseEvent(
  terminal: Terminal,
  event: MouseEvent
): string | null {
  if ((event.button !== 0 && event.button !== 1) || !isTerminalOwnedLinkGesture(event)) {
    return null
  }
  const position = getTerminalBufferPositionForMouseEvent(terminal, event)
  return position
    ? findTerminalHttpLinkAtBufferPosition(terminal.buffer.active, position, terminal.cols)
    : null
}

/** Resolve HTTP targets under eligible clicks when the native linkifier has not activated them. */
export function installHttpLinkClickFallback(
  terminal: Terminal,
  deps: UrlLinkClickFallbackDeps
): HttpLinkClickFallbackBinding {
  const isLinkMouseEvent = (event: MouseEvent): boolean => {
    if (
      isTerminalLinkFloatingActivation(event)
        ? isTerminalLinkifierHoverAtMouseEvent(terminal, event) || deps.isValidatedFileLink?.(event)
        : isTerminalLinkifierHoverActive(terminal)
    ) {
      return true
    }
    const position = getTerminalBufferPositionForMouseEvent(terminal, event)
    return Boolean(
      position &&
      findTerminalHttpLinkAtBufferPosition(terminal.buffer.active, position, terminal.cols)
    )
  }
  const ptyMouseSuppression = installTerminalLinkPtyMouseSuppression(
    terminal,
    isLinkMouseEvent,
    (event) => {
      const context = deps.getLinkActionContext?.(event)
      return Boolean(context?.pointerGesture.canRequestAction(event) && isLinkMouseEvent(event))
    },
    (event) => Boolean(deps.getLinkActionContext?.(event)?.pointerGesture.canRequestAction(event))
  )
  const handleMouseUp = (event: MouseEvent): void => {
    if (!isDesktopHttpLinkFallbackActivation(event)) {
      return
    }

    // Why: xterm's WebLinksAddon misses first clicks before hover state exists.
    const url = findHttpLinkAtTerminalMouseEvent(terminal, event)
    const handled = Boolean(
      url &&
      handleTerminalHttpLink(url, event, {
        worktreeId: deps.worktreeId,
        sourceTabId: deps.sourceTabId,
        sourceOwner: deps.getSourceOwner?.() ?? { kind: 'local' },
        requestOpenLinksInAppPreference: deps.requestOpenLinksInAppPreference,
        linkActionContext: deps.getLinkActionContext?.(event),
        actionDestinations: deps.getActionDestinations?.()
      })
    )
    if (handled) {
      event.preventDefault()
      terminal.clearSelection()
    }
  }

  const terminalElement = terminal.element
  terminalElement?.addEventListener('mouseup', handleMouseUp)
  return {
    ptyMouseSuppression,
    dispose: () => {
      ptyMouseSuppression.dispose()
      terminalElement?.removeEventListener('mouseup', handleMouseUp)
    }
  }
}

export function openHttpLinkAtBufferPosition(
  buffer: { getLine(y: number): IBufferLine | undefined },
  position: { x: number; y: number },
  terminalColumns: number,
  deps: UrlLinkHitTestDeps
): boolean {
  const url = findTerminalHttpLinkAtBufferPosition(buffer, position, terminalColumns)
  if (!url) {
    return false
  }
  openRoutedHttpLink(url, deps)
  return true
}
