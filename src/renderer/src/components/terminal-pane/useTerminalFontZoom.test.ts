// @vitest-environment happy-dom
import type * as ReactModule from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTerminalFontZoom } from './useTerminalFontZoom'

const mocks = vi.hoisted(() => ({
  captureScrollState: vi.fn(() => ({ wasAtBottom: true })),
  restoreScrollState: vi.fn(),
  safeFit: vi.fn(),
  dispatchZoomLevelChanged: vi.fn()
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>()
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => effect()
  }
})

vi.mock('@/lib/pane-manager/pane-tree-ops', () => ({
  captureScrollState: mocks.captureScrollState,
  restoreScrollState: mocks.restoreScrollState,
  safeFit: mocks.safeFit
}))

vi.mock('@/lib/zoom-events', () => ({
  dispatchZoomLevelChanged: mocks.dispatchZoomLevelChanged
}))

describe('useTerminalFontZoom', () => {
  let terminalZoomListeners: ((direction: 'in' | 'out' | 'reset') => void)[]

  beforeEach(() => {
    terminalZoomListeners = []
    document.body.replaceChildren()
    vi.clearAllMocks()
    vi.stubGlobal('window', {
      api: {
        ui: {
          onTerminalZoom: vi.fn((listener: (direction: 'in' | 'out' | 'reset') => void) => {
            terminalZoomListeners.push(listener)
            return () => {}
          })
        }
      }
    })
  })

  function useMountedTerminalFontZoom(activeElement: HTMLElement): {
    terminal: { options: { fontSize?: number } }
    listener: (direction: 'in' | 'out' | 'reset') => void
  } {
    const container = document.createElement('div')
    document.body.appendChild(container)
    container.appendChild(activeElement)
    activeElement.focus()
    const terminal = { options: { fontSize: 14 } }
    useTerminalFontZoom({
      isActive: true,
      containerRef: { current: container },
      managerRef: {
        current: {
          getActivePane: () => ({ id: 1, terminal })
        }
      } as never,
      paneFontSizesRef: { current: new Map() },
      settingsRef: { current: { terminalFontSize: 14 } }
    })
    const listener = terminalZoomListeners.at(-1)
    expect(listener).toBeTypeOf('function')
    return { terminal, listener: listener as (direction: 'in' | 'out' | 'reset') => void }
  }

  it('ignores zoom events when terminal input no longer owns focus', () => {
    const button = document.createElement('button')
    const { listener, terminal } = useMountedTerminalFontZoom(button)

    listener('in')

    expect(terminal.options.fontSize).toBe(14)
    expect(mocks.safeFit).not.toHaveBeenCalled()
    expect(mocks.dispatchZoomLevelChanged).not.toHaveBeenCalled()
  })

  it('applies terminal font zoom while the xterm helper textarea owns focus', () => {
    const helper = document.createElement('textarea')
    helper.className = 'xterm-helper-textarea'
    const { listener, terminal } = useMountedTerminalFontZoom(helper)

    listener('in')

    expect(terminal.options.fontSize).toBe(15)
    expect(mocks.safeFit).toHaveBeenCalledTimes(1)
    expect(mocks.dispatchZoomLevelChanged).toHaveBeenCalledWith('terminal', 107)
  })

  it('only lets the pane owning the focused helper apply terminal font zoom', () => {
    const inactiveContainer = document.createElement('div')
    const activeContainer = document.createElement('div')
    const focusedHelper = document.createElement('textarea')
    focusedHelper.className = 'xterm-helper-textarea'
    document.body.append(inactiveContainer, activeContainer)
    activeContainer.appendChild(focusedHelper)
    focusedHelper.focus()

    const inactiveTerminal = { options: { fontSize: 14 } }
    const activeTerminal = { options: { fontSize: 14 } }
    useTerminalFontZoom({
      isActive: true,
      containerRef: { current: inactiveContainer },
      managerRef: {
        current: {
          getActivePane: () => ({ id: 1, terminal: inactiveTerminal })
        }
      } as never,
      paneFontSizesRef: { current: new Map() },
      settingsRef: { current: { terminalFontSize: 14 } }
    })
    useTerminalFontZoom({
      isActive: true,
      containerRef: { current: activeContainer },
      managerRef: {
        current: {
          getActivePane: () => ({ id: 2, terminal: activeTerminal })
        }
      } as never,
      paneFontSizesRef: { current: new Map() },
      settingsRef: { current: { terminalFontSize: 14 } }
    })

    for (const listener of terminalZoomListeners) {
      listener('in')
    }

    expect(inactiveTerminal.options.fontSize).toBe(14)
    expect(activeTerminal.options.fontSize).toBe(15)
    expect(mocks.safeFit).toHaveBeenCalledTimes(1)
  })
})
