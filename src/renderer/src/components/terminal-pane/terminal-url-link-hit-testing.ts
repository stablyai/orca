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

const HTTP_SCHEME_PREFIXES = ['https://', 'http://'] as const
export const TERMINAL_HTTP_URL_MAX_LENGTH = 2048

export function extractTerminalHttpLinks(lineText: string): ParsedTerminalHttpLink[] {
  const links: ParsedTerminalHttpLink[] = []
  for (const candidate of iterateTerminalHttpUrlCandidates(lineText)) {
    let parsed: URL
    try {
      parsed = new URL(candidate.url)
    } catch {
      continue
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      continue
    }
    links.push({
      url: parsed.toString(),
      startIndex: candidate.startIndex,
      endIndex: candidate.endIndex
    })
  }
  return links
}

function isPrimaryHttpLinkFallbackActivation(event: MouseEvent): boolean {
  if (event.defaultPrevented || event.button !== 0) {
    return false
  }
  // Why: URL links now open on ordinary clicks, but macOS Ctrl-click must stay
  // available for context menus even when Chromium reports it as button 0.
  return !(navigator.userAgent.includes('Mac') && event.ctrlKey && !event.metaKey)
}

function* iterateTerminalHttpUrlCandidates(
  lineText: string
): Generator<{ url: string; startIndex: number; endIndex: number }> {
  let searchStart = 0
  while (searchStart < lineText.length) {
    const startIndex = findNextHttpSchemeIndex(lineText, searchStart)
    if (startIndex === -1) {
      return
    }

    if (!hasHttpUrlWordBoundary(lineText, startIndex)) {
      searchStart = startIndex + 1
      continue
    }

    const rawEndIndex = findHttpUrlCandidateEnd(lineText, startIndex)
    const endIndex = trimHttpUrlTrailingPunctuation(lineText, startIndex, rawEndIndex)
    searchStart = Math.max(rawEndIndex, startIndex + 1)
    if (endIndex <= startIndex || rawEndIndex - startIndex > TERMINAL_HTTP_URL_MAX_LENGTH) {
      continue
    }

    yield {
      url: lineText.slice(startIndex, endIndex),
      startIndex,
      endIndex
    }
  }
}

function findNextHttpSchemeIndex(lineText: string, searchStart: number): number {
  let nextIndex = -1
  for (const prefix of HTTP_SCHEME_PREFIXES) {
    const candidateIndex = lineText.indexOf(prefix, searchStart)
    if (candidateIndex !== -1 && (nextIndex === -1 || candidateIndex < nextIndex)) {
      nextIndex = candidateIndex
    }
  }
  return nextIndex
}

function hasHttpUrlWordBoundary(lineText: string, startIndex: number): boolean {
  return startIndex === 0 || !isAsciiWordCode(lineText.charCodeAt(startIndex - 1))
}

function findHttpUrlCandidateEnd(lineText: string, startIndex: number): number {
  const scanEnd = Math.min(lineText.length, startIndex + TERMINAL_HTTP_URL_MAX_LENGTH + 1)
  for (let index = startIndex; index < scanEnd; index += 1) {
    if (isHttpUrlBodyTerminator(lineText.charCodeAt(index))) {
      return index
    }
  }
  return scanEnd
}

function trimHttpUrlTrailingPunctuation(
  lineText: string,
  startIndex: number,
  rawEndIndex: number
): number {
  let endIndex = rawEndIndex
  while (endIndex > startIndex && isHttpUrlTrailingPunctuation(lineText.charCodeAt(endIndex - 1))) {
    endIndex -= 1
  }
  return endIndex
}

function isHttpUrlBodyTerminator(code: number): boolean {
  return (
    isAsciiWhitespace(code) ||
    code === 0x22 ||
    code === 0x27 ||
    code === 0x21 ||
    code === 0x2a ||
    code === 0x28 ||
    code === 0x29 ||
    code === 0x7b ||
    code === 0x7d ||
    code === 0x7c ||
    code === 0x5c ||
    code === 0x5e ||
    code === 0x3c ||
    code === 0x3e ||
    code === 0x60
  )
}

function isHttpUrlTrailingPunctuation(code: number): boolean {
  return (
    isAsciiWhitespace(code) ||
    code === 0x22 ||
    code === 0x27 ||
    code === 0x3a ||
    code === 0x2c ||
    code === 0x2e ||
    code === 0x21 ||
    code === 0x3f ||
    code === 0x7b ||
    code === 0x7d ||
    code === 0x7c ||
    code === 0x5c ||
    code === 0x5e ||
    code === 0x7e ||
    code === 0x5b ||
    code === 0x5d ||
    code === 0x28 ||
    code === 0x29 ||
    code === 0x3c ||
    code === 0x3e ||
    code === 0x60
  )
}

function isAsciiWhitespace(code: number): boolean {
  return code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32
}

function isAsciiWordCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    code === 95 ||
    (code >= 97 && code <= 122)
  )
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
    if (!isPrimaryHttpLinkFallbackActivation(event)) {
      return
    }

    const position = getBufferPositionForTerminalMouseEvent(terminal, event)
    if (!position) {
      return
    }

    // Why: xterm's WebLinksAddon only activates after hover state exists. This
    // direct mouseup fallback preserves ordinary link clicks when the hover link
    // was never established, while defaultPrevented avoids duplicate opens.
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
