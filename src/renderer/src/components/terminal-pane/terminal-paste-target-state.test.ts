import { describe, expect, it, vi } from 'vitest'
import {
  isTerminalPanePasteFocusCurrent,
  isTerminalPanePasteTargetCurrent
} from './terminal-paste-target-state'

function makeTransport(options: { connected?: boolean; ptyId?: string | null } = {}) {
  return {
    getPtyId: vi.fn(() => options.ptyId ?? 'pty-1'),
    isConnected: vi.fn(() => options.connected ?? true)
  }
}

function makePaneContainer(acceptedElement: Element): Element {
  return {
    contains: vi.fn((element: Element | null) => element === acceptedElement)
  } as unknown as Element
}

function makePaneContainerFor(acceptedElements: readonly Element[]): Element {
  return {
    contains: vi.fn((element: Element | null) => acceptedElements.includes(element as Element))
  } as unknown as Element
}

function makeElement(tagName: string, classNames: string[] = []): Element {
  return {
    tagName,
    classList: {
      contains: (className: string) => classNames.includes(className)
    }
  } as unknown as Element
}

describe('terminal paste target state', () => {
  it('accepts the same mounted pane, transport, and PTY identity', () => {
    const transport = makeTransport()

    expect(
      isTerminalPanePasteTargetCurrent({
        manager: { getPanes: () => [{ id: 1, leafId: 'leaf-1' }] },
        paneTransports: new Map([[1, transport]]),
        paneId: 1,
        leafId: 'leaf-1',
        transport,
        ptyId: 'pty-1'
      })
    ).toBe(true)
  })

  it('rejects stale pane identity before paste execution can write', () => {
    const transport = makeTransport()

    expect(
      isTerminalPanePasteTargetCurrent({
        manager: { getPanes: () => [{ id: 1, leafId: 'new-leaf' }] },
        paneTransports: new Map([[1, transport]]),
        paneId: 1,
        leafId: 'leaf-1',
        transport,
        ptyId: 'pty-1'
      })
    ).toBe(false)
  })

  it('rejects replaced transports and changed PTY ids', () => {
    const transport = makeTransport()
    const replacement = makeTransport()

    expect(
      isTerminalPanePasteTargetCurrent({
        manager: { getPanes: () => [{ id: 1, leafId: 'leaf-1' }] },
        paneTransports: new Map([[1, replacement]]),
        paneId: 1,
        leafId: 'leaf-1',
        transport,
        ptyId: 'pty-1'
      })
    ).toBe(false)
    expect(
      isTerminalPanePasteTargetCurrent({
        manager: { getPanes: () => [{ id: 1, leafId: 'leaf-1' }] },
        paneTransports: new Map([[1, transport]]),
        paneId: 1,
        leafId: 'leaf-1',
        transport: makeTransport({ ptyId: 'pty-2' }),
        ptyId: 'pty-1'
      })
    ).toBe(false)
  })

  it('rejects disconnected or unavailable targets without consulting stale transports', () => {
    const disconnected = makeTransport({ connected: false })

    expect(
      isTerminalPanePasteTargetCurrent({
        manager: { getPanes: () => [{ id: 1, leafId: 'leaf-1' }] },
        paneTransports: new Map([[1, disconnected]]),
        paneId: 1,
        leafId: 'leaf-1',
        transport: disconnected,
        ptyId: 'pty-1'
      })
    ).toBe(false)
    expect(
      isTerminalPanePasteTargetCurrent({
        manager: null,
        paneTransports: new Map(),
        paneId: 1,
        leafId: 'leaf-1',
        transport: undefined,
        ptyId: null
      })
    ).toBe(false)
  })

  it('keeps keyboard-owned paste current while the dispatch element still has focus', () => {
    const terminalInput = {} as Element
    const paneContainer = makePaneContainer(terminalInput)

    expect(
      isTerminalPanePasteFocusCurrent({
        requireSameFocusedElement: true,
        activeElementAtDispatch: terminalInput,
        paneContainer,
        activeElement: terminalInput
      })
    ).toBe(true)
  })

  it('rejects keyboard-owned paste when focus moves before execution', () => {
    const terminalInput = {} as Element
    const renameInput = {} as Element
    const paneContainer = makePaneContainer(terminalInput)

    expect(
      isTerminalPanePasteFocusCurrent({
        requireSameFocusedElement: true,
        activeElementAtDispatch: terminalInput,
        paneContainer,
        activeElement: renameInput
      })
    ).toBe(false)
  })

  it('keeps keyboard-owned paste current across transient document blur', () => {
    const terminalInput = {} as Element
    const body = makeElement('body')
    const paneContainer = makePaneContainer(terminalInput)

    expect(
      isTerminalPanePasteFocusCurrent({
        requireSameFocusedElement: true,
        activeElementAtDispatch: terminalInput,
        paneContainer,
        activeElement: body
      })
    ).toBe(true)
  })

  it('keeps keyboard-owned paste current when xterm replaces its helper textarea', () => {
    const originalTerminalInput = makeElement('textarea', ['xterm-helper-textarea'])
    const replacementTerminalInput = makeElement('textarea', ['xterm-helper-textarea'])
    const paneContainer = makePaneContainerFor([originalTerminalInput, replacementTerminalInput])

    expect(
      isTerminalPanePasteFocusCurrent({
        requireSameFocusedElement: true,
        activeElementAtDispatch: originalTerminalInput,
        paneContainer,
        activeElement: replacementTerminalInput
      })
    ).toBe(true)
  })

  it('rejects keyboard-owned paste when focus moves to another control in the pane', () => {
    const terminalInput = makeElement('textarea', ['xterm-helper-textarea'])
    const searchInput = makeElement('input')
    const paneContainer = makePaneContainerFor([terminalInput, searchInput])

    expect(
      isTerminalPanePasteFocusCurrent({
        requireSameFocusedElement: true,
        activeElementAtDispatch: terminalInput,
        paneContainer,
        activeElement: searchInput
      })
    ).toBe(false)
  })

  it('does not require focus continuity for programmatic terminal paste', () => {
    const terminalInput = {} as Element
    const otherInput = {} as Element
    const paneContainer = makePaneContainer(terminalInput)

    expect(
      isTerminalPanePasteFocusCurrent({
        requireSameFocusedElement: false,
        activeElementAtDispatch: terminalInput,
        paneContainer,
        activeElement: otherInput
      })
    ).toBe(true)
  })
})
