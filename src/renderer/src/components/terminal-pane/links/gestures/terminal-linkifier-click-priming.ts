import type { IDisposable, Terminal } from '@xterm/xterm'
import {
  isTerminalLinkFloatingWorkspaceActivation,
  isTerminalOwnedLinkGesture
} from './terminal-link-activation'
import { isTerminalLinkifierHoverActive } from '@/lib/pane-manager/terminal-linkifier-hover-reset'

const CAPTURE_LISTENER_OPTIONS = { capture: true } as const

type LinkifierClickPrimer = {
  _activeLine?: number
  _currentLink?: unknown
  _handleMouseMove?: (event: MouseEvent) => void
  _lastBufferCell?: unknown
}

type TerminalCoreWithLinkifier = {
  _core?: {
    linkifier?: LinkifierClickPrimer
  }
}

function primeTerminalLinkifier(terminal: Terminal, event: MouseEvent): void {
  try {
    const linkifier = (terminal as unknown as TerminalCoreWithLinkifier)._core?.linkifier
    if (!linkifier || typeof linkifier._handleMouseMove !== 'function') {
      return
    }
    if (!linkifier._currentLink) {
      if ('_lastBufferCell' in linkifier) {
        linkifier._lastBufferCell = undefined
      }
      if ('_activeLine' in linkifier) {
        linkifier._activeLine = -1
      }
    }
    linkifier._handleMouseMove(event)
  } catch {
    /* xterm internals unavailable — hover still primes later clicks */
  }
}

export function installTerminalLinkifierClickPriming(terminal: Terminal): IDisposable {
  const terminalElement = terminal.element
  const ownerWindow = terminalElement?.ownerDocument?.defaultView
  let restoreAltClickMovesCursor: (() => void) | null = null
  const restoreAltClick = (): void => {
    restoreAltClickMovesCursor?.()
    restoreAltClickMovesCursor = null
  }
  const queueRestoreAltClick = (): void => {
    ownerWindow?.setTimeout(restoreAltClick, 0)
  }
  const handleMouseDown = (event: MouseEvent): void => {
    restoreAltClick()
    const floatingActivation = isTerminalLinkFloatingWorkspaceActivation(event)
    if (!floatingActivation && !isTerminalOwnedLinkGesture(event)) {
      return
    }
    // Prime on mousedown: xterm normally resolves on mousemove, missing first clicks on output painted under a still pointer.
    primeTerminalLinkifier(terminal, event)
    if (
      floatingActivation &&
      terminal.options.altClickMovesCursor !== false &&
      isTerminalLinkifierHoverActive(terminal)
    ) {
      // Why: xterm's Alt+click would also send cursor-move arrow keys to the shell or agent.
      const previous = terminal.options.altClickMovesCursor
      terminal.options.altClickMovesCursor = false
      // Why after a tick: xterm reads the option in its own document mouseup listener.
      ownerWindow?.addEventListener('mouseup', queueRestoreAltClick)
      ownerWindow?.addEventListener('blur', restoreAltClick)
      restoreAltClickMovesCursor = () => {
        terminal.options.altClickMovesCursor = previous
        ownerWindow?.removeEventListener('mouseup', queueRestoreAltClick)
        ownerWindow?.removeEventListener('blur', restoreAltClick)
      }
    }
  }

  terminalElement?.addEventListener('mousedown', handleMouseDown, CAPTURE_LISTENER_OPTIONS)
  return {
    dispose: () => {
      restoreAltClick()
      terminalElement?.removeEventListener('mousedown', handleMouseDown, CAPTURE_LISTENER_OPTIONS)
    }
  }
}
