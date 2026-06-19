import type { IBufferLine, IBufferRange, IDisposable, Terminal } from '@xterm/xterm'
import { openHttpLink } from '@/lib/http-link-routing'
import { buildCandidateLogicalLinesForBufferPosition } from './terminal-file-link-hit-testing'
import {
  getTerminalHttpRouteModeForEvent,
  type TerminalHttpRouteContext,
  type TerminalBrowserTipNotifier
} from './terminal-http-link-routing'
import { rangeForParsedFileLink } from './wrapped-terminal-link-ranges'

type UrlLinkHitTestDeps = {
  worktreeId: string
  routeMode?: 'default' | 'force-system' | 'force-orca-if-supported' | 'alternate'
  runtimeEnvironmentId?: string | null
  activeRuntimeEnvironmentId?: string | null
  connectionId?: string | null
  openLinksInApp?: boolean
  notifyTerminalBrowserTip?: TerminalBrowserTipNotifier
}

type UrlLinkClickFallbackDeps = {
  worktreeId: string
  runtimeEnvironmentId?: string | null
  activeRuntimeEnvironmentId?: string | null
  connectionId?: string | null
  openLinksInApp?: boolean
  getRouteContext?: () => TerminalHttpRouteContext
  notifyTerminalBrowserTip?: TerminalBrowserTipNotifier
}

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

function isPrimaryHttpLinkFallbackActivation(event: MouseEvent): boolean {
  if (event.defaultPrevented || event.button !== 0) {
    return false
  }
  // Why: URL links now open on ordinary clicks, but macOS Ctrl-click must stay
  // available for context menus even when Chromium reports it as button 0.
  return !(navigator.userAgent.includes('Mac') && event.ctrlKey && !event.metaKey)
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
    const routeContext = deps.getRouteContext?.() ?? deps
    const opened = openHttpLinkAtBufferPosition(terminal.buffer.active, position, terminal.cols, {
      worktreeId: routeContext.worktreeId ?? deps.worktreeId,
      routeMode: getTerminalHttpRouteModeForEvent(event),
      runtimeEnvironmentId: routeContext.runtimeEnvironmentId,
      activeRuntimeEnvironmentId: routeContext.activeRuntimeEnvironmentId,
      connectionId: routeContext.connectionId,
      openLinksInApp: routeContext.openLinksInApp,
      notifyTerminalBrowserTip: deps.notifyTerminalBrowserTip
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
  void deps.notifyTerminalBrowserTip?.({
    worktreeId: deps.worktreeId,
    activeRuntimeEnvironmentId: deps.activeRuntimeEnvironmentId,
    runtimeEnvironmentId: deps.runtimeEnvironmentId,
    connectionId: deps.connectionId,
    openLinksInApp: deps.openLinksInApp
  })
  openHttpLink(url, {
    worktreeId: deps.worktreeId,
    routeMode: deps.routeMode ?? 'default',
    runtimeEnvironmentId: deps.runtimeEnvironmentId,
    connectionId: deps.connectionId
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
