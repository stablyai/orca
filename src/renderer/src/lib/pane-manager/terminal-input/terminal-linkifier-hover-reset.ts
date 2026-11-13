import { classifyTerminalOscLinkTarget } from '../../../../../shared/terminal/links/terminal-osc-link-target'
import { getTerminalBufferPositionForMouseEvent } from '@/components/terminal-pane/input/pointer/terminal-mouse-buffer-position'
import type { Terminal } from '@xterm/xterm'

type LinkifierHoverCache = {
  _lastBufferCell?: unknown
  _activeLine?: number
  // Private xterm cleanup that invokes the active provider's leave callback
  // and removes its pointer cursor decoration.
  _clearCurrentLink?: () => void
  // Set while xterm is showing a hovered link; cleared on mouseleave / when the
  // pointer moves off the link (Linkifier `_clearCurrentLink`).
  _currentLink?: unknown
  _lastMouseEvent?: MouseEvent
  _handleMouseMove?: (event: MouseEvent) => void
}

type TerminalCoreWithLinkifier = {
  _core?: {
    linkifier?: LinkifierHoverCache
  }
}

export function refreshStaleTerminalLinkifierHover(terminal: Terminal): boolean {
  try {
    // SAFETY: private linkifier access is optional and every invoked member is checked below.
    const linkifier = (terminal as unknown as TerminalCoreWithLinkifier)._core?.linkifier
    const current = linkifier?._currentLink
    if (
      !current ||
      typeof current !== 'object' ||
      !('link' in current) ||
      !current.link ||
      typeof current.link !== 'object' ||
      !('isBufferValid' in current.link) ||
      typeof current.link.isBufferValid !== 'function' ||
      current.link.isBufferValid()
    ) {
      return false
    }
    const event = linkifier?._lastMouseEvent
    resetTerminalLinkifierHoverState(terminal)
    if (event && typeof linkifier?._handleMouseMove === 'function') {
      linkifier._handleMouseMove(event)
    }
    return true
  } catch {
    return false
  }
}

/** mouseleave clears links but retains xterm’s cell cache, so reveal at the same cell skips providers. Invalidate cell/line caches for the next move. No public API exists; guard pinned Linkifier internals so upgrades degrade to recovery on a real cell change. */
export function resetTerminalLinkifierHoverState(terminal: Terminal): void {
  try {
    const linkifier = (terminal as unknown as TerminalCoreWithLinkifier)._core?.linkifier
    // Window blur can strand active links; invoke provider leave separately so its failure cannot skip cache invalidation.
    try {
      linkifier?._clearCurrentLink?.()
    } catch {
      /* provider leave() threw — cache invalidation below still applies */
    }
    if (linkifier && '_currentLink' in linkifier) {
      linkifier._currentLink = undefined
    }
    if (linkifier && '_lastBufferCell' in linkifier) {
      linkifier._lastBufferCell = undefined
    }
    if (linkifier && '_activeLine' in linkifier) {
      linkifier._activeLine = -1
    }
    // Restore the cursor even if private cleanup or its last mouse event is unavailable.
    terminal.element
      ?.querySelector<HTMLElement>('.xterm-screen')
      ?.classList.remove('xterm-cursor-pointer')
  } catch {
    /* linkifier internals unavailable — link recovers on the next cell change */
  }
}

/** Timers must defer invalidation while hovering or async providers flicker underline/tooltips. Missing private state degrades to not hovering, as with resetTerminalLinkifierHoverState. */
export function isTerminalLinkifierHoverActive(terminal: Terminal): boolean {
  try {
    const linkifier = (terminal as unknown as TerminalCoreWithLinkifier)._core?.linkifier
    return Boolean(linkifier && '_currentLink' in linkifier && linkifier._currentLink)
  } catch {
    return false
  }
}

/** Only a link covering this cell may reserve an Alt click from xterm. */
export function isTerminalLinkifierHoverAtMouseEvent(
  terminal: Terminal,
  event: MouseEvent
): boolean {
  const position = getTerminalBufferPositionForMouseEvent(terminal, event)
  // SAFETY: xterm's pinned linkifier shape is checked before reading its range.
  const current = (terminal as unknown as TerminalCoreWithLinkifier)._core?.linkifier?._currentLink
  if (!position || !current || typeof current !== 'object' || !('link' in current)) {
    return false
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: optional fields of the pinned xterm link are checked before use.
  const link = current.link as {
    text?: string
    range?: { start: { x: number; y: number }; end: { x: number; y: number } }
    isBufferValid?: () => boolean
  }
  const range = link?.range
  const supported =
    typeof link?.text === 'string' &&
    classifyTerminalOscLinkTarget(link.text, {
      windowsPathsFirst: navigator.userAgent.includes('Windows'),
      allowUncHost: navigator.userAgent.includes('Windows')
    })
  return Boolean(
    supported &&
    range?.start &&
    range.end &&
    (typeof link.isBufferValid !== 'function' || link.isBufferValid()) &&
    (position.y > range.start.y || (position.y === range.start.y && position.x >= range.start.x)) &&
    (position.y < range.end.y || (position.y === range.end.y && position.x <= range.end.x))
  )
}
