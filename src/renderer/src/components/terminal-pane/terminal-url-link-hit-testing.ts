import type { IBufferLine, IBufferRange, IDisposable, Terminal } from '@xterm/xterm'
import { openHttpLink, type HttpLinkSourceOwner } from '@/lib/http-link-routing'
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
import { translate } from '@/i18n/i18n'
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

export type TerminalHttpLinkDestination = 'orca' | 'system'

export type TerminalHttpLinkActionDestinations = {
  primary: TerminalHttpLinkDestination
  alternate?: TerminalHttpLinkDestination
}

export type TerminalLinkRoutingPreferenceRequester = (
  url: string
) => boolean | Promise<boolean> | null | undefined

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
    openTerminalHttpLink(url, {
      ...deps,
      modifierHeld: forceDestination ? false : Boolean(event?.shiftKey),
      forceDestination
    })
    return true
  }

  const actionDestinations = deps.actionDestinations
  const primaryDestination = actionDestinations?.primary
  const labelForDestination = (destination: TerminalHttpLinkDestination): string =>
    destination === 'orca'
      ? translate(
          'auto.components.terminal.pane.TerminalLinkActionPopover.orcaBrowser',
          'Orca Browser'
        )
      : translate(
          'auto.components.terminal.pane.TerminalLinkActionPopover.systemBrowser',
          'System Browser'
        )

  return requestTerminalLinkAction(event, deps.linkActionContext, {
    destination: deps.actionDestination ?? url,
    kind: 'url',
    primary: {
      external: primaryDestination === 'system',
      label: primaryDestination
        ? labelForDestination(primaryDestination)
        : translate(
            'auto.components.terminal.pane.TerminalLinkActionPopover.openLink',
            'Open link'
          ),
      run: () =>
        openTerminalHttpLink(url, {
          ...deps,
          modifierHeld: false,
          forceDestination: primaryDestination
        })
    },
    ...(actionDestinations?.alternate
      ? {
          alternate: {
            external: actionDestinations.alternate === 'system',
            label: labelForDestination(actionDestinations.alternate),
            run: () =>
              openTerminalHttpLink(url, {
                ...deps,
                modifierHeld: false,
                forceDestination: actionDestinations.alternate
              })
          }
        }
      : {})
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
  openTerminalHttpLink(url, deps)
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

export function openTerminalHttpLink(url: string, deps: UrlLinkHitTestDeps): void {
  // Why: pane ownership beats the global active runtime for both local and remote routes.
  const sourceOwner = deps.sourceOwner ?? { kind: 'local' }
  if (deps.forceDestination) {
    openHttpLink(url, {
      allowRemoteInApp: true,
      worktreeId: deps.worktreeId,
      forceInApp: deps.forceDestination === 'orca',
      forceSystemBrowser: deps.forceDestination === 'system',
      sourceOwner
    })
    return
  }
  if (deps.modifierHeld) {
    // Why: the modifier states a destination outright, so it also skips the
    // one-time routing prompt; openHttpLink resolves which destination it means.
    openHttpLink(url, {
      allowRemoteInApp: true,
      worktreeId: deps.worktreeId,
      modifierHeld: true,
      sourceOwner
    })
    return
  }

  // Why: remote panes use the persisted routing preference and never prompt the viewing client.
  const preferenceDecision =
    sourceOwner.kind === 'local' ? deps.requestOpenLinksInAppPreference?.(url) : null
  if (preferenceDecision === null || preferenceDecision === undefined) {
    openHttpLink(url, { allowRemoteInApp: true, worktreeId: deps.worktreeId, sourceOwner })
    return
  }

  // Why: the first terminal link click may need an async preference dialog.
  // Suppress the browser's default link handling first, then route after the
  // persisted choice is available.
  void Promise.resolve(preferenceDecision)
    .then((openInOrca) => {
      openHttpLink(url, {
        allowRemoteInApp: true,
        worktreeId: deps.worktreeId,
        forceSystemBrowser: !openInOrca,
        sourceOwner
      })
    })
    .catch(() => {
      openHttpLink(url, {
        allowRemoteInApp: true,
        worktreeId: deps.worktreeId,
        forceSystemBrowser: true,
        sourceOwner
      })
    })
}
