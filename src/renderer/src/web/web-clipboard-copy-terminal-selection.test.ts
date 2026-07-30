// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { copyClipboardTextViaExecCommand } from './web-clipboard-copy-fallback'

// Why a real DOM: only genuine capture/bubble propagation reproduces the ordering bug.

type ClipboardDataStub = {
  setData: (format: string, value: string) => void
  getData: (format: string) => string
}

function createClipboardDataStub(): ClipboardDataStub {
  const store = new Map<string, string>()
  return {
    setData(format, value) {
      store.set(format, value)
    },
    getData(format) {
      return store.get(format) ?? ''
    }
  }
}

/** Stands in for xterm's copyHandler: bubble-phase, overwrites text/plain. */
function mountTerminalWithSelection(selectionText: string): HTMLElement {
  const terminalElement = document.createElement('div')
  document.body.appendChild(terminalElement)
  terminalElement.addEventListener('copy', (event) => {
    const clipboardData = (event as unknown as { clipboardData?: ClipboardDataStub }).clipboardData
    clipboardData?.setData('text/plain', selectionText)
    event.preventDefault()
  })
  return terminalElement
}

/** Stands in for execCommand('copy'): dispatches from the DOM selection's anchor. */
function stubExecCommand(
  source: HTMLElement,
  clipboardData: ClipboardDataStub,
  // Runs once the fallback has registered, so a handler added here is ordered after it.
  beforeDispatch?: () => void
): void {
  ;(document as unknown as { execCommand: (command: string) => boolean }).execCommand = (
    command
  ) => {
    if (command !== 'copy') {
      return false
    }
    beforeDispatch?.()
    const event = new Event('copy', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: clipboardData })
    source.dispatchEvent(event)
    return true
  }
}

describe('web copy fallback vs. the terminal selection', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('copies the requested text even when the selection anchor is inside a terminal', () => {
    // Copy Path / Copy Pane ID leave the selection in the terminal, so the copy event
    // dispatches from there and a capture-phase write loses to xterm's bubble handler.
    const terminalElement = mountTerminalWithSelection('rm -rf ./secret-dir')
    const clipboardData = createClipboardDataStub()
    stubExecCommand(terminalElement, clipboardData)

    expect(copyClipboardTextViaExecCommand('/Users/me/repo/src/index.ts', document)).toBe(true)
    expect(clipboardData.getData('text/plain')).toBe('/Users/me/repo/src/index.ts')
  })

  it('wins over a later document-level copy handler', () => {
    // Same target as the fallback's own listener, so only stopImmediatePropagation
    // suppresses it — stopPropagation would still let it run and clobber text/plain.
    const source = document.createElement('div')
    document.body.appendChild(source)
    const clipboardData = createClipboardDataStub()
    const clobber = (event: Event): void => {
      const data = (event as unknown as { clipboardData?: ClipboardDataStub }).clipboardData
      data?.setData('text/plain', 'later document handler')
    }
    stubExecCommand(source, clipboardData, () => document.addEventListener('copy', clobber))

    try {
      expect(copyClipboardTextViaExecCommand('pane-42', document)).toBe(true)
      expect(clipboardData.getData('text/plain')).toBe('pane-42')
    } finally {
      document.removeEventListener('copy', clobber)
    }
  })

  it('wins over a copy handler that still runs after the document', () => {
    // Bubbling hits the document before the window, so only stopImmediatePropagation
    // protects against a window-level listener.
    const source = document.createElement('div')
    document.body.appendChild(source)
    const clipboardData = createClipboardDataStub()
    stubExecCommand(source, clipboardData)
    const clobber = (event: Event): void => {
      const data = (event as unknown as { clipboardData?: ClipboardDataStub }).clipboardData
      data?.setData('text/plain', 'later window handler')
    }
    window.addEventListener('copy', clobber)

    try {
      expect(copyClipboardTextViaExecCommand('pane-42', document)).toBe(true)
      expect(clipboardData.getData('text/plain')).toBe('pane-42')
    } finally {
      window.removeEventListener('copy', clobber)
    }
  })
})
