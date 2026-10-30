import { terminalLinkPressCandidate } from './terminal-link-press-candidate'
import {
  isTerminalLinkDirectActivation,
  isTerminalMiddleClickActivation
} from './terminal-link-activation'
import {
  prepareTerminalLinkActivation,
  commitTerminalLinkActivation,
  type TerminalLinkCommit
} from './terminal-link-activation-operation'
import type { IBufferLine, IDisposable, Terminal } from '@xterm/xterm'
import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
import { isTerminalHttpLinkActivation } from './terminal-http-link-activation'
import {
  installTerminalLinkPtyMouseSuppression,
  type TerminalLinkPtyMouseSuppression
} from './terminal-link-pty-mouse-suppression'
import { getTerminalBufferPositionForMouseEvent } from './terminal-mouse-buffer-position'
import { findTerminalHttpLinkAtBufferPosition } from '../../../../shared/terminal-link-buffer-hit-testing'
import {
  buildHttpLinkActions,
  httpLinkDirectClickDestination,
  openRoutedHttpLink,
  type HttpLinkActionDestinations,
  type HttpLinkDestination,
  type HttpLinkRoutingPreferenceRequester
} from '@/lib/http-link-destinations'
import { isTerminalOwnedLinkGesture } from './terminal-link-activation'
import {
  requestTerminalLinkAction,
  type TerminalLinkActionContext
} from './terminal-link-action-request'

export { extractTerminalHttpLinks } from '../../../../shared/terminal-http-url-extraction'
export { TERMINAL_HTTP_URL_MAX_LENGTH } from '../../../../shared/terminal-http-link-limits'

type UrlLinkHitTestDeps = {
  worktreeId: string
  sourceTabId?: string | null
  sourceOwner?: HttpLinkSourceOwner
  modifierHeld?: boolean
  requestOpenLinksInAppPreference?: TerminalLinkRoutingPreferenceRequester
  linkActionContext?: TerminalLinkActionContext | null
  actionDestinations?: TerminalHttpLinkActionDestinations
  commit?: TerminalLinkCommit
  actionDestination?: string
  forceDestination?: TerminalHttpLinkDestination
}

type UrlLinkClickFallbackDeps = {
  worktreeId: string
  sourceTabId?: string | null
  /** Resolved per click: the pane's PTY (and its runtime binding) may not exist at install time. */
  getSourceOwner?: () => HttpLinkSourceOwner
  requestOpenLinksInAppPreference?: TerminalLinkRoutingPreferenceRequester
  getLinkActionContext?: () => TerminalLinkActionContext | null
  getActionDestinations?: () => TerminalHttpLinkActionDestinations
}

export type HttpLinkClickFallbackBinding = IDisposable & {
  ptyMouseSuppression: TerminalLinkPtyMouseSuppression
}

export type TerminalHttpLinkDestination = HttpLinkDestination

export type TerminalHttpLinkActionDestinations = HttpLinkActionDestinations

export type TerminalLinkRoutingPreferenceRequester = HttpLinkRoutingPreferenceRequester

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
    return commitTerminalLinkActivation(
      event,
      prepareTerminalLinkActivation(event, {
        kind: 'url',
        direct: () =>
          openRoutedHttpLink(url, {
            ...deps,
            modifierHeld: forceDestination ? false : Boolean(event?.shiftKey),
            forceDestination
          }),
        details: () => {}
      }),
      deps.commit ?? deps.linkActionContext?.commit
    )
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

export function installHttpLinkClickFallback(
  terminal: Terminal,
  deps: UrlLinkClickFallbackDeps
): HttpLinkClickFallbackBinding {
  const ptyMouseSuppression = installTerminalLinkPtyMouseSuppression(terminal, {
    candidate: (event) => terminalLinkPressCandidate(terminal, event, true),
    eligible: (event) => {
      if (isTerminalLinkDirectActivation(event)) {
        return true
      }
      const context = deps.getLinkActionContext?.()
      const mode = isTerminalMiddleClickActivation(event)
        ? context?.middleClickBehavior
        : context?.plainClickBehavior
      return Boolean(context && mode !== 'none' && context.pointerGesture.canRequestAction(event))
    },
    canContinue: (event) =>
      Boolean(deps.getLinkActionContext?.()?.pointerGesture.canRequestAction(event))
  })
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
        commit: ptyMouseSuppression.commit,
        linkActionContext: deps.getLinkActionContext?.(),
        actionDestinations: deps.getActionDestinations?.()
      })
    )
    if (handled) {
      event.preventDefault()
    }
  }

  const terminalElement = terminal.element
  terminalElement?.addEventListener('mouseup', handleMouseUp)
  return {
    ptyMouseSuppression,
    dispose: () => {
      try {
        ptyMouseSuppression.dispose()
      } finally {
        terminalElement?.removeEventListener('mouseup', handleMouseUp)
      }
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
