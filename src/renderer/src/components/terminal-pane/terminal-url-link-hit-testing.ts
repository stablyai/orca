import type { IBufferLine, IBufferRange, IDisposable, Terminal } from '@xterm/xterm'
import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
import { buildEdgeWrappedHttpLogicalLineCandidates } from './edge-wrapped-terminal-http-links'
import { buildHardWrappedHttpLogicalLineCandidates } from './hard-wrapped-terminal-http-links'
import { dedupeLogicalLines } from './terminal-file-link-hit-testing'
import { isTerminalHttpLinkActivation } from './terminal-http-link-activation'
import {
  installTerminalLinkPtyMouseSuppression,
  type TerminalLinkPtyMouseSuppression
} from './terminal-link-pty-mouse-suppression'
import { getTerminalBufferPositionForMouseEvent } from './terminal-mouse-buffer-position'
import { extractTerminalHttpLinks } from './terminal-http-url-extraction'
import { buildWrappedLogicalLine, rangeForParsedFileLink } from './wrapped-terminal-link-ranges'
import { isTerminalLinkifierHoverActive } from '@/lib/pane-manager/terminal-linkifier-hover-reset'
import {
  buildHttpLinkActions,
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

export { extractTerminalHttpLinks } from './terminal-http-url-extraction'
export { TERMINAL_HTTP_URL_MAX_LENGTH } from './terminal-http-link-limits'

type UrlLinkHitTestDeps = {
  worktreeId: string
  sourceOwner?: HttpLinkSourceOwner
  modifierHeld?: boolean
  requestOpenLinksInAppPreference?: TerminalLinkRoutingPreferenceRequester
  linkActionContext?: TerminalLinkActionContext | null
  actionDestinations?: TerminalHttpLinkActionDestinations
  actionDestination?: string
  forceDestination?: TerminalHttpLinkDestination
}

type UrlLinkClickFallbackDeps = {
  worktreeId: string
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
  if (event.defaultPrevented || event.button !== 0) {
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
    const forceDestination = event?.shiftKey
      ? (deps.actionDestinations?.alternate ?? deps.actionDestinations?.primary)
      : deps.actionDestinations?.primary
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
    ...buildHttpLinkActions(deps.actionDestinations, (destination) =>
      openRoutedHttpLink(url, { ...deps, modifierHeld: false, forceDestination: destination })
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
  if (event.button !== 0 || !isTerminalOwnedLinkGesture(event)) {
    return null
  }
  const position = getTerminalBufferPositionForMouseEvent(terminal, event)
  return position
    ? findHttpLinkAtBufferPosition(terminal.buffer.active, position, terminal.cols)
    : null
}

export function installHttpLinkClickFallback(
  terminal: Terminal,
  deps: UrlLinkClickFallbackDeps
): HttpLinkClickFallbackBinding {
  const isLinkMouseEvent = (event: MouseEvent): boolean => {
    if (isTerminalLinkifierHoverActive(terminal)) {
      return true
    }
    const position = getTerminalBufferPositionForMouseEvent(terminal, event)
    return Boolean(
      position && findHttpLinkAtBufferPosition(terminal.buffer.active, position, terminal.cols)
    )
  }
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
        sourceOwner: deps.getSourceOwner?.() ?? { kind: 'local' },
        requestOpenLinksInAppPreference: deps.requestOpenLinksInAppPreference,
        linkActionContext: deps.getLinkActionContext?.(),
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
  const url = findHttpLinkAtBufferPosition(buffer, position, terminalColumns)
  if (!url) {
    return false
  }
  openRoutedHttpLink(url, deps)
  return true
}

function findHttpLinkAtBufferPosition(
  buffer: { getLine(y: number): IBufferLine | undefined },
  position: { x: number; y: number },
  terminalColumns: number
): string | null {
  const nativeWrappedLogicalLine = buildWrappedLogicalLine(buffer, position.y)
  const logicalLines = dedupeLogicalLines([
    ...(nativeWrappedLogicalLine && nativeWrappedLogicalLine.rows.length > 1
      ? [nativeWrappedLogicalLine]
      : []),
    ...buildHardWrappedHttpLogicalLineCandidates(buffer, position.y),
    ...buildEdgeWrappedHttpLogicalLineCandidates(buffer, position.y),
    ...(nativeWrappedLogicalLine && nativeWrappedLogicalLine.rows.length === 1
      ? [nativeWrappedLogicalLine]
      : [])
  ])
  if (logicalLines.length === 0) {
    return null
  }

  for (const logicalLine of logicalLines) {
    for (const parsed of extractTerminalHttpLinks(logicalLine.text)) {
      const range = rangeForParsedFileLink(logicalLine, parsed.startIndex, parsed.endIndex)
      if (!range || !rangeContainsBufferPosition(range, position, terminalColumns)) {
        continue
      }
      return parsed.url
    }
  }

  return null
}

function rangeContainsBufferPosition(
  range: IBufferRange,
  position: { x: number; y: number },
  terminalColumns: number
): boolean {
  const lower = range.start.y * terminalColumns + range.start.x
  const upper = range.end.y * terminalColumns + range.end.x
  const current = position.y * terminalColumns + position.x
  return lower <= current && current <= upper
}
