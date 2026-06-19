import type { IBufferLine, IBufferRange, IDisposable, Terminal } from '@xterm/xterm'
import { openHttpLink } from '@/lib/http-link-routing'
import { buildCandidateLogicalLinesForBufferPosition } from './terminal-file-link-hit-testing'
import { rangeForParsedFileLink } from './wrapped-terminal-link-ranges'

type UrlLinkHitTestDeps = {
  worktreeId: string
  forceSystemBrowser?: boolean
  requestOpenLinksInAppPreference?: TerminalLinkRoutingPreferenceRequester
}

type UrlLinkClickFallbackDeps = {
  worktreeId: string
  requestOpenLinksInAppPreference?: TerminalLinkRoutingPreferenceRequester
}

export type TerminalLinkRoutingPreferenceRequester = (
  url: string
) => boolean | Promise<boolean> | null | undefined

type ParsedTerminalHttpLink = {
  url: string
  startIndex: number
  endIndex: number
}

// Mirrors @xterm/addon-web-links' strict URL matcher so fallback clicks use
// the same visible URL span as xterm's hover-time WebLinksAddon provider.
const TERMINAL_HTTP_URL_REGEX = /\bhttps?:\/\/[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/gi

function extractTerminalHttpLinks(lineText: string): ParsedTerminalHttpLink[] {
  const links: ParsedTerminalHttpLink[] = []
  for (const match of lineText.matchAll(TERMINAL_HTTP_URL_REGEX)) {
    const url = match[0]
    const index = match.index ?? 0
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      continue
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      continue
    }
    links.push({ url: parsed.toString(), startIndex: index, endIndex: index + url.length })
  }
  return links
}

function isTerminalLinkActivation(
  event: Pick<MouseEvent, 'metaKey' | 'ctrlKey'> | undefined
): boolean {
  const isMac = navigator.userAgent.includes('Mac')
  return isMac ? Boolean(event?.metaKey) : Boolean(event?.ctrlKey)
}

function getTerminalScreenElement(terminal: Terminal): HTMLElement | null {
  return terminal.element?.querySelector('.xterm-screen') ?? null
}

function getBufferPositionForTerminalMouseEvent(
  terminal: Terminal,
  event: MouseEvent
): { x: number; y: number } | null {
  const screenElement = getTerminalScreenElement(terminal)
  if (!screenElement || terminal.cols <= 0 || terminal.rows <= 0) {
    return null
  }

  const rect = screenElement.getBoundingClientRect()
  const relativeX = event.clientX - rect.left
  const relativeY = event.clientY - rect.top
  if (relativeX < 0 || relativeY < 0 || relativeX >= rect.width || relativeY >= rect.height) {
    return null
  }

  const cellWidth = rect.width / terminal.cols
  const cellHeight = rect.height / terminal.rows
  if (cellWidth <= 0 || cellHeight <= 0) {
    return null
  }

  return {
    x: Math.floor(relativeX / cellWidth) + 1,
    y: Math.floor(relativeY / cellHeight) + terminal.buffer.active.viewportY + 1
  }
}

export function installHttpLinkClickFallback(
  terminal: Terminal,
  deps: UrlLinkClickFallbackDeps
): IDisposable {
  const handleMouseUp = (event: MouseEvent): void => {
    if (event.defaultPrevented || event.button !== 0 || !isTerminalLinkActivation(event)) {
      return
    }

    const position = getBufferPositionForTerminalMouseEvent(terminal, event)
    if (!position) {
      return
    }

    // Why: xterm's WebLinksAddon only activates after hover state exists. This
    // direct mouseup fallback preserves Cmd/Ctrl-click when the hover link was
    // never established, while defaultPrevented avoids double-opening links
    // that xterm already handled.
    const opened = openHttpLinkAtBufferPosition(terminal.buffer.active, position, terminal.cols, {
      worktreeId: deps.worktreeId,
      forceSystemBrowser: event.shiftKey,
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
  const logicalLines = buildCandidateLogicalLinesForBufferPosition(buffer, position.y)
  if (logicalLines.length === 0) {
    return false
  }

  for (const logicalLine of logicalLines) {
    for (const parsed of extractTerminalHttpLinks(logicalLine.text)) {
      const range = rangeForParsedFileLink(logicalLine, parsed.startIndex, parsed.endIndex)
      if (!range || !rangeContainsBufferPosition(range, position, terminalColumns)) {
        continue
      }
      openTerminalHttpLink(parsed.url, deps)
      return true
    }
  }

  return false
}

export function openTerminalHttpLink(url: string, deps: UrlLinkHitTestDeps): void {
  if (deps.forceSystemBrowser) {
    openHttpLink(url, { worktreeId: deps.worktreeId, forceSystemBrowser: true })
    return
  }

  const preferenceDecision = deps.requestOpenLinksInAppPreference?.(url)
  if (preferenceDecision === null || preferenceDecision === undefined) {
    openHttpLink(url, { worktreeId: deps.worktreeId })
    return
  }

  // Why: the first terminal link click may need an async preference dialog.
  // Suppress the browser's default link handling first, then route after the
  // persisted choice is available.
  void Promise.resolve(preferenceDecision)
    .then((openInOrca) => {
      openHttpLink(url, {
        worktreeId: deps.worktreeId,
        forceSystemBrowser: !openInOrca
      })
    })
    .catch(() => {
      openHttpLink(url, { worktreeId: deps.worktreeId, forceSystemBrowser: true })
    })
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
