import { describe, expect, it, vi } from 'vitest'
import {
  reclaimTerminalPaneFocus,
  type TerminalFocusTarget,
  type TerminalFocusTargetContainer,
  type TerminalFocusTargetDocument
} from './terminal-pane-menu-focus'

describe('reclaimTerminalPaneFocus', () => {
  const syncScheduler = (cb: () => void) => cb()

  it('does nothing when pane is null or undefined', () => {
    expect(() => reclaimTerminalPaneFocus(null, { scheduleRefocus: syncScheduler })).not.toThrow()
    expect(() => reclaimTerminalPaneFocus(undefined, { scheduleRefocus: syncScheduler })).not.toThrow()
  })

  it('does not focus if container is not connected to the DOM', () => {
    const focusMock = vi.fn()
    const container = document.createElement('div')
    const pane: TerminalFocusTarget = {
      container,
      terminal: { focus: focusMock }
    }

    reclaimTerminalPaneFocus(pane, { scheduleRefocus: syncScheduler })
    expect(focusMock).not.toHaveBeenCalled()
  })

  it('reclaims focus when activeElement is document.body', () => {
    const focusMock = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    try {
      const mockDoc: TerminalFocusTargetDocument = {
        body: document.body,
        activeElement: document.body
      }
      const containerTarget: TerminalFocusTargetContainer = {
        isConnected: true,
        ownerDocument: mockDoc
      }
      const pane: TerminalFocusTarget = {
        container: containerTarget,
        terminal: { focus: focusMock }
      }

      reclaimTerminalPaneFocus(pane, { scheduleRefocus: syncScheduler })
      expect(focusMock).toHaveBeenCalledTimes(1)
    } finally {
      container.remove()
    }
  })

  it('reclaims focus when activeElement is null', () => {
    const focusMock = vi.fn()
    const mockDoc: TerminalFocusTargetDocument = {
      body: document.body,
      activeElement: null
    }
    const containerTarget: TerminalFocusTargetContainer = {
      isConnected: true,
      ownerDocument: mockDoc
    }
    const pane: TerminalFocusTarget = {
      container: containerTarget,
      terminal: { focus: focusMock }
    }

    reclaimTerminalPaneFocus(pane, { scheduleRefocus: syncScheduler })
    expect(focusMock).toHaveBeenCalledTimes(1)
  })

  it('reclaims focus when activeElement is the container itself', () => {
    const focusMock = vi.fn()
    const containerElement = document.createElement('div')
    const mockDoc: TerminalFocusTargetDocument = {
      body: document.body,
      activeElement: containerElement
    }
    const containerTarget: TerminalFocusTargetContainer = {
      isConnected: true,
      ownerDocument: mockDoc
    }
    const pane: TerminalFocusTarget = {
      container: containerTarget,
      terminal: { focus: focusMock }
    }

    reclaimTerminalPaneFocus(pane, { scheduleRefocus: syncScheduler })
    expect(focusMock).toHaveBeenCalledTimes(1)
  })

  it('reclaims focus when activeElement is inside terminal element', () => {
    const focusMock = vi.fn()
    const terminalElement = document.createElement('div')
    const terminalChild = document.createElement('div')
    terminalElement.appendChild(terminalChild)

    const mockDoc: TerminalFocusTargetDocument = {
      body: document.body,
      activeElement: terminalChild
    }
    const containerTarget: TerminalFocusTargetContainer = {
      isConnected: true,
      ownerDocument: mockDoc
    }
    const pane: TerminalFocusTarget = {
      container: containerTarget,
      terminal: { focus: focusMock, element: terminalElement }
    }

    reclaimTerminalPaneFocus(pane, { scheduleRefocus: syncScheduler })
    expect(focusMock).toHaveBeenCalledTimes(1)
  })

  it('reclaims focus when activeElement is xterm helper textarea', () => {
    const focusMock = vi.fn()
    const textarea = document.createElement('textarea')
    textarea.classList.add('xterm-helper-textarea')

    const mockDoc: TerminalFocusTargetDocument = {
      body: document.body,
      activeElement: textarea
    }
    const containerTarget: TerminalFocusTargetContainer = {
      isConnected: true,
      ownerDocument: mockDoc
    }
    const pane: TerminalFocusTarget = {
      container: containerTarget,
      terminal: { focus: focusMock, textarea }
    }

    reclaimTerminalPaneFocus(pane, { scheduleRefocus: syncScheduler })
    expect(focusMock).toHaveBeenCalledTimes(1)
  })

  it('does NOT steal focus when activeElement is an in-pane control (e.g. search input)', () => {
    const focusMock = vi.fn()
    const container = document.createElement('div')
    const terminalElement = document.createElement('div')
    const searchInput = document.createElement('input')
    container.appendChild(terminalElement)
    container.appendChild(searchInput)

    const mockDoc: TerminalFocusTargetDocument = {
      body: document.body,
      activeElement: searchInput
    }
    const containerTarget: TerminalFocusTargetContainer = {
      isConnected: true,
      ownerDocument: mockDoc
    }
    const pane: TerminalFocusTarget = {
      container: containerTarget,
      terminal: { focus: focusMock, element: terminalElement }
    }

    reclaimTerminalPaneFocus(pane, { scheduleRefocus: syncScheduler })
    expect(focusMock).not.toHaveBeenCalled()
  })

  it('does NOT steal focus when activeElement is an outside element', () => {
    const focusMock = vi.fn()
    const outsideElement = document.createElement('button')

    const mockDoc: TerminalFocusTargetDocument = {
      body: document.body,
      activeElement: outsideElement
    }
    const containerTarget: TerminalFocusTargetContainer = {
      isConnected: true,
      ownerDocument: mockDoc
    }
    const pane: TerminalFocusTarget = {
      container: containerTarget,
      terminal: { focus: focusMock }
    }

    reclaimTerminalPaneFocus(pane, { scheduleRefocus: syncScheduler })
    expect(focusMock).not.toHaveBeenCalled()
  })
})
