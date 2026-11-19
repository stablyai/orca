import type { IBufferLine, IDisposable, Terminal } from '@xterm/xterm'
import type { HttpLinkSourceOwner } from '@/lib/browser/navigation/http-link-routing'
import {
  isTerminalLinkDirectActivation as isTerminalHttpLinkActivation,
  isTerminalOwnedLinkGesture
} from '../gestures/terminal-link-activation'
import {
  installTerminalLinkPtyMouseSuppression,
  type TerminalLinkPtyMouseSuppression
} from '../gestures/terminal-link-pty-mouse-suppression'
import { getTerminalBufferPositionForMouseEvent } from '../../input/pointer/terminal-mouse-buffer-position'
import { findTerminalHttpLinkAtBufferPosition } from '../../../../../../shared/terminal/links/terminal-link-buffer-hit-testing'
import { isTerminalLinkifierHoverActive } from '@/lib/pane-manager/terminal-input/terminal-linkifier-hover-reset'
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
  type TerminalLinkActionContext
} from '../terminal-link-action-request'
import { captureLinkActionContext } from '@/lib/links/preferences/link-action-context'
import {
  canRememberLinkChoice,
  rememberOnAdmission
} from '@/lib/links/preferences/link-remember-choice'

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
  getLinkActionContext?: () => TerminalLinkActionContext | null
  getActionDestinations?: (url: string) => HttpLinkActionDestinations
}

export type HttpLinkClickFallbackBinding = IDisposable & {
  ptyMouseSuppression: TerminalLinkPtyMouseSuppression
}

function isDesktopHttpLinkFallbackActivation(event: MouseEvent): boolean {
  if (event.defaultPrevented || (event.button !== 0 && event.button !== 1)) {
    return false
  }
  // Why: Shift-only, Alt, and non-primary clicks remain available to the terminal or child TUI.
  return isTerminalOwnedLinkGesture(event)
}

export function handleTerminalHttpLink(
  url: string,
  event: MouseEvent | undefined,
  deps: UrlLinkHitTestDeps
): boolean {
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

  const rememberMode = deps.linkActionContext?.rememberMode
  // Captured at click: the chooser's actions must not follow later focus or host changes.
  const actionContext = rememberMode
    ? captureLinkActionContext(deps.worktreeId, deps.sourceTabId)
    : undefined
  const chooserDeps = actionContext ? { ...deps, actionContext } : deps
  return requestTerminalLinkAction(event, deps.linkActionContext, {
    destination: deps.actionDestination ?? url,
    kind: 'url',
    ...(rememberMode && actionContext && deps.actionDestinations
      ? {
          linkPreferenceHost: true,
          rememberEligible: canRememberLinkChoice({
            plainClick: true,
            mode: rememberMode,
            destinations: deps.actionDestinations,
            actionContext
          })
        }
      : {}),
    ...buildHttpLinkActions(
      deps.actionDestinations,
      (destination, choice) => {
        const onAdmission = destination ? rememberOnAdmission(destination, choice) : undefined
        openRoutedHttpLink(url, {
          ...chooserDeps,
          modifierHeld: false,
          forceDestination: destination,
          ...(onAdmission ? { onAdmission } : {})
        })
      },
      {
        ...deps,
        url,
        openInSourceGroup: () =>
          openRoutedHttpLink(url, {
            ...chooserDeps,
            forceDestination: 'orca',
            openInSourceGroup: true
          })
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

export function isTerminalLinkAtMouseEvent(terminal: Terminal, event: MouseEvent): boolean {
  if (isTerminalLinkifierHoverActive(terminal)) {
    return true
  }
  const position = getTerminalBufferPositionForMouseEvent(terminal, event)
  return Boolean(
    position &&
    findTerminalHttpLinkAtBufferPosition(terminal.buffer.active, position, terminal.cols)
  )
}

export function installHttpLinkClickFallback(
  terminal: Terminal,
  deps: UrlLinkClickFallbackDeps
): HttpLinkClickFallbackBinding {
  const isLinkMouseEvent = (event: MouseEvent): boolean =>
    isTerminalLinkAtMouseEvent(terminal, event)
  const ptyMouseSuppression = installTerminalLinkPtyMouseSuppression(
    terminal,
    isLinkMouseEvent,
    (event) => {
      const context = deps.getLinkActionContext?.()
      return Boolean(context?.pointerGesture.canRequestAction(event) && isLinkMouseEvent(event))
    },
    (event) => Boolean(deps.getLinkActionContext?.()?.pointerGesture.canRequestAction(event))
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
        linkActionContext: deps.getLinkActionContext?.(),
        actionDestinations: deps.getActionDestinations?.(url)
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
