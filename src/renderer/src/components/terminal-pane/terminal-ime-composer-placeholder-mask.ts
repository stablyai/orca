import type { IDisposable, Terminal } from '@xterm/xterm'
import { hasTerminalComposerPlaceholder } from '../../../../shared/terminal-composer-draft'
import { readTerminalCursorLineContext } from '../../../../shared/terminal-cursor-line-context'
import {
  XTERM_COMPOSITION_SESSION_END_EVENT,
  XTERM_COMPOSITION_SESSION_START_EVENT
} from './terminal-ime-composition-route'

export const TERMINAL_IME_COMPOSER_PLACEHOLDER_CLASS = 'orca-ime-composer-placeholder'

function compositionSessionId(event: Event): number | null {
  if (!(event instanceof CustomEvent)) {
    return null
  }
  const id = (event.detail as { id?: unknown } | null)?.id
  return Number.isSafeInteger(id) && Number(id) > 0 ? Number(id) : null
}

/** Claim placeholder masking before xterm paints each remainder; disposal releases composition ownership. */
export function installTerminalImeComposerPlaceholderMask(terminal: Terminal): IDisposable {
  const element = terminal.element
  if (!element) {
    return { dispose: () => undefined }
  }

  // xterm renders one composition view; a newer transaction supersedes any older pending one.
  // Keeping only its id makes malformed/repeated starts bounded without evicting live ownership.
  let activeSessionId: number | null = null
  const syncPlaceholderOwnership = (): void => {
    const ownsPlaceholder =
      activeSessionId !== null &&
      hasTerminalComposerPlaceholder(readTerminalCursorLineContext(terminal, terminal.rows))
    element.classList.toggle(TERMINAL_IME_COMPOSER_PLACEHOLDER_CLASS, ownsPlaceholder)
  }
  const handleSessionStart = (event: Event): void => {
    const id = compositionSessionId(event)
    if (id === null) {
      return
    }
    activeSessionId = id
    syncPlaceholderOwnership()
  }
  const handleSessionEnd = (event: Event): void => {
    const id = compositionSessionId(event)
    if (id === null) {
      return
    }
    if (activeSessionId === id) {
      activeSessionId = null
    }
    syncPlaceholderOwnership()
  }
  const handleBlur = (): void => {
    activeSessionId = null
    syncPlaceholderOwnership()
  }
  // xterm requests the remainder during repaint, before deciding whether to draw its mask.
  const handleRemainder = (event: Event): void => {
    syncPlaceholderOwnership()
    if (element.classList.contains(TERMINAL_IME_COMPOSER_PLACEHOLDER_CLASS)) {
      event.preventDefault()
    }
  }

  element.addEventListener('xterm-composition-remainder', handleRemainder)
  element.addEventListener(XTERM_COMPOSITION_SESSION_START_EVENT, handleSessionStart)
  element.addEventListener(XTERM_COMPOSITION_SESSION_END_EVENT, handleSessionEnd)
  element.addEventListener('blur', handleBlur, true)

  return {
    dispose: () => {
      activeSessionId = null
      element.classList.remove(TERMINAL_IME_COMPOSER_PLACEHOLDER_CLASS)
      element.removeEventListener('xterm-composition-remainder', handleRemainder)
      element.removeEventListener(XTERM_COMPOSITION_SESSION_START_EVENT, handleSessionStart)
      element.removeEventListener(XTERM_COMPOSITION_SESSION_END_EVENT, handleSessionEnd)
      element.removeEventListener('blur', handleBlur, true)
    }
  }
}
