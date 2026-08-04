import type { IBufferLine, IBufferRange, IDisposable, Terminal } from '@xterm/xterm'
import { openHttpLink, type HttpLinkSourceOwner } from '@/lib/http-link-routing'
import { buildEdgeWrappedHttpLogicalLineCandidates } from './edge-wrapped-terminal-http-links'
import { buildHardWrappedHttpLogicalLineCandidates } from './hard-wrapped-terminal-http-links'
import { dedupeLogicalLines } from './terminal-file-link-hit-testing'
import { isTerminalHttpLinkActivation } from './terminal-http-link-activation'
import { installTerminalLinkPtyMouseSuppression } from './terminal-link-pty-mouse-suppression'
import { getTerminalBufferPositionForMouseEvent } from './terminal-mouse-buffer-position'
import { extractTerminalHttpLinks } from './terminal-http-url-extraction'
import { buildWrappedLogicalLine, rangeForParsedFileLink } from './wrapped-terminal-link-ranges'
import { isTerminalLinkifierHoverActive } from '@/lib/pane-manager/terminal-linkifier-hover-reset'

export { extractTerminalHttpLinks } from './terminal-http-url-extraction'
export { TERMINAL_HTTP_URL_MAX_LENGTH } from './terminal-http-link-limits'

type UrlLinkHitTestDeps = {
  worktreeId: string
  sourceOwner?: HttpLinkSourceOwner
  modifierHeld?: boolean
  requestOpenLinksInAppPreference?: TerminalLinkRoutingPreferenceRequester
}

type UrlLinkClickFallbackDeps = {
  worktreeId: string
  /** Resolved per click: the pane's PTY (and its runtime binding) may not exist at install time. */
  getSourceOwner?: () => HttpLinkSourceOwner
  requestOpenLinksInAppPreference?: TerminalLinkRoutingPreferenceRequester
}

export type TerminalLinkRoutingPreferenceRequester = (
  url: string
) => boolean | Promise<boolean> | null | undefined

function isDesktopHttpLinkFallbackActivation(event: MouseEvent): boolean {
  if (event.defaultPrevented || event.button !== 0) {
    return false
  }
  // Why: desktop terminal links require an intentional Cmd/Ctrl gesture so
  // plain clicks remain available for cursor placement and selection. Mobile
  // tap routing is handled separately under mobile/src/terminal.
  return isTerminalHttpLinkActivation(event)
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

export function installHttpLinkClickFallback(
  terminal: Terminal,
  deps: UrlLinkClickFallbackDeps
): IDisposable {
  const ptyMouseSuppression = installTerminalLinkPtyMouseSuppression(terminal, (event) => {
    if (isTerminalLinkifierHoverActive(terminal)) {
      return true
    }
    const position = getTerminalBufferPositionForMouseEvent(terminal, event)
    return Boolean(
      position && findHttpLinkAtBufferPosition(terminal.buffer.active, position, terminal.cols)
    )
  })
  const handleMouseUp = (event: MouseEvent): void => {
    if (!isDesktopHttpLinkFallbackActivation(event)) {
      return
    }

    // Why: xterm's WebLinksAddon only activates after hover state exists. This
    // direct mouseup fallback preserves modifier-clicks when the hover link was
    // never established, while defaultPrevented avoids duplicate opens.
    const opened = openHttpLinkAtTerminalMouseEvent(terminal, event, {
      worktreeId: deps.worktreeId,
      sourceOwner: deps.getSourceOwner?.() ?? { kind: 'local' },
      modifierHeld: event.shiftKey,
      requestOpenLinksInAppPreference: deps.requestOpenLinksInAppPreference
    })
    if (opened) {
      event.preventDefault()
      terminal.clearSelection()
    }
  }

  const terminalElement = terminal.element
  terminalElement?.addEventListener('mouseup', handleMouseUp)
  return {
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
  // Why: Orca browser tabs are local-only, so a link clicked in a runtime-hosted
  // pane must be classified by its pane's host, not the global active runtime.
  const sourceOwner = deps.sourceOwner ?? { kind: 'local' }
  if (deps.modifierHeld) {
    // Why: the modifier states a destination outright, so it also skips the
    // one-time routing prompt; openHttpLink resolves which destination it means.
    openHttpLink(url, { worktreeId: deps.worktreeId, modifierHeld: true, sourceOwner })
    return
  }

  // Why: a runtime-hosted link can only reach the system browser, so prompting
  // would persist an in-app preference this click cannot honor.
  const preferenceDecision =
    sourceOwner.kind === 'local' ? deps.requestOpenLinksInAppPreference?.(url) : null
  if (preferenceDecision === null || preferenceDecision === undefined) {
    openHttpLink(url, { worktreeId: deps.worktreeId, sourceOwner })
    return
  }

  // Why: the first terminal link click may need an async preference dialog.
  // Suppress the browser's default link handling first, then route after the
  // persisted choice is available.
  void Promise.resolve(preferenceDecision)
    .then((openInOrca) => {
      openHttpLink(url, {
        worktreeId: deps.worktreeId,
        forceSystemBrowser: !openInOrca,
        sourceOwner
      })
    })
    .catch(() => {
      openHttpLink(url, { worktreeId: deps.worktreeId, forceSystemBrowser: true, sourceOwner })
    })
}
