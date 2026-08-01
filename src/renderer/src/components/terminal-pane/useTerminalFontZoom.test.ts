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
    useEffect: (effect: () => void | (() => void)) => effect(),
    useRef: <T>(initialValue: T) => ({ current: initialValue })
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

  function useMountedTerminalFontZoom(
    activeElement: HTMLElement,
    terminalFontSize: number | null = 14
  ): {
    terminals: { options: { fontSize?: number } }[]
    listener: (direction: 'in' | 'out' | 'reset') => void
    updateSettings: ReturnType<typeof vi.fn>
  } {
    const container = document.createElement('div')
    document.body.appendChild(container)
    container.appendChild(activeElement)
    activeElement.focus()
    const terminals = [{ options: { fontSize: 12 } }, { options: { fontSize: 18 } }]
    const panes = terminals.map((terminal, index) => ({ id: index + 1, terminal }))
    const updateSettings = vi.fn()
    useTerminalFontZoom({
      isActive: true,
      containerRef: { current: container },
      managerRef: {
        current: {
          getPanes: () => panes
        }
      } as never,
      settingsRef: {
        current: terminalFontSize === null ? null : { terminalFontSize }
      },
      updateSettings
    })
    const listener = terminalZoomListeners.at(-1)
    expect(listener).toBeTypeOf('function')
    return {
      terminals,
      listener: listener as (direction: 'in' | 'out' | 'reset') => void,
      updateSettings
    }
  }

  it('ignores zoom events when terminal input no longer owns focus', () => {
    const button = document.createElement('button')
    const { listener, terminals, updateSettings } = useMountedTerminalFontZoom(button)

    listener('in')

    expect(terminals.map((terminal) => terminal.options.fontSize)).toEqual([12, 18])
    expect(mocks.safeFit).not.toHaveBeenCalled()
    expect(updateSettings).not.toHaveBeenCalled()
    expect(mocks.dispatchZoomLevelChanged).not.toHaveBeenCalled()
  })

  it('does not apply or persist zoom before settings load', () => {
    const helper = document.createElement('textarea')
    helper.className = 'xterm-helper-textarea'
    const { listener, terminals, updateSettings } = useMountedTerminalFontZoom(helper, null)

    listener('in')

    expect(terminals.map((terminal) => terminal.options.fontSize)).toEqual([12, 18])
    expect(mocks.safeFit).not.toHaveBeenCalled()
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('applies and persists the global font size to every pane while terminal owns focus', () => {
    const helper = document.createElement('textarea')
    helper.className = 'xterm-helper-textarea'
    const { listener, terminals, updateSettings } = useMountedTerminalFontZoom(helper)

    listener('in')

    expect(terminals.map((terminal) => terminal.options.fontSize)).toEqual([15, 15])
    expect(mocks.safeFit).toHaveBeenCalledTimes(2)
    expect(updateSettings).toHaveBeenCalledOnce()
    expect(updateSettings).toHaveBeenCalledWith({ terminalFontSize: 15 })
    expect(mocks.dispatchZoomLevelChanged).toHaveBeenCalledWith('terminal', 107)
  })

  it('resets to the configured base size and reports zoom relative to that base', () => {
    const helper = document.createElement('textarea')
    helper.className = 'xterm-helper-textarea'
    const { listener, terminals, updateSettings } = useMountedTerminalFontZoom(helper, 20)

    listener('in')

    expect(terminals.map((terminal) => terminal.options.fontSize)).toEqual([21, 21])
    expect(updateSettings).toHaveBeenLastCalledWith({ terminalFontSize: 21 })
    expect(mocks.dispatchZoomLevelChanged).toHaveBeenLastCalledWith('terminal', 105)

    listener('reset')

    expect(terminals.map((terminal) => terminal.options.fontSize)).toEqual([20, 20])
    expect(updateSettings).toHaveBeenLastCalledWith({ terminalFontSize: 20 })
    expect(mocks.dispatchZoomLevelChanged).toHaveBeenLastCalledWith('terminal', 100)
    expect(mocks.safeFit).toHaveBeenCalledTimes(4)
  })

  it('preserves the configured base independently across hooks sharing settings', () => {
    const firstContainer = document.createElement('div')
    const secondContainer = document.createElement('div')
    const firstHelper = document.createElement('textarea')
    const secondHelper = document.createElement('textarea')
    firstHelper.className = 'xterm-helper-textarea'
    secondHelper.className = 'xterm-helper-textarea'
    firstContainer.appendChild(firstHelper)
    secondContainer.appendChild(secondHelper)
    document.body.append(firstContainer, secondContainer)

    const sharedSettingsRef = { current: { terminalFontSize: 20 } }
    const firstTerminal = { options: { fontSize: 20 } }
    const secondTerminal = { options: { fontSize: 20 } }
    const updateSettings = vi.fn()
    useTerminalFontZoom({
      isActive: true,
      containerRef: { current: firstContainer },
      managerRef: {
        current: { getPanes: () => [{ id: 1, terminal: firstTerminal }] }
      } as never,
      settingsRef: sharedSettingsRef,
      updateSettings
    })
    useTerminalFontZoom({
      isActive: true,
      containerRef: { current: secondContainer },
      managerRef: {
        current: { getPanes: () => [{ id: 2, terminal: secondTerminal }] }
      } as never,
      settingsRef: sharedSettingsRef,
      updateSettings
    })

    firstHelper.focus()
    terminalZoomListeners[0]('in')
    expect(sharedSettingsRef.current.terminalFontSize).toBe(21)

    secondHelper.focus()
    terminalZoomListeners[1]('reset')

    expect(secondTerminal.options.fontSize).toBe(20)
    expect(updateSettings).toHaveBeenLastCalledWith({ terminalFontSize: 20 })
    expect(mocks.dispatchZoomLevelChanged).toHaveBeenLastCalledWith('terminal', 100)
  })

  it('clamps zoom out and resets the persisted size to the global default', () => {
    const helper = document.createElement('textarea')
    helper.className = 'xterm-helper-textarea'
    const { listener, terminals, updateSettings } = useMountedTerminalFontZoom(helper)

    for (let step = 0; step < 10; step += 1) {
      listener('out')
    }
    expect(terminals.map((terminal) => terminal.options.fontSize)).toEqual([8, 8])
    expect(updateSettings).toHaveBeenLastCalledWith({ terminalFontSize: 8 })

    listener('reset')
    expect(terminals.map((terminal) => terminal.options.fontSize)).toEqual([14, 14])
    expect(updateSettings).toHaveBeenLastCalledWith({ terminalFontSize: 14 })
    expect(mocks.dispatchZoomLevelChanged).toHaveBeenLastCalledWith('terminal', 100)
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
    const activeTerminals = [{ options: { fontSize: 12 } }, { options: { fontSize: 18 } }]
    useTerminalFontZoom({
      isActive: true,
      containerRef: { current: inactiveContainer },
      managerRef: {
        current: {
          getPanes: () => [{ id: 1, terminal: inactiveTerminal }]
        }
      } as never,
      settingsRef: { current: { terminalFontSize: 14 } },
      updateSettings: vi.fn()
    })
    useTerminalFontZoom({
      isActive: true,
      containerRef: { current: activeContainer },
      managerRef: {
        current: {
          getPanes: () => activeTerminals.map((terminal, index) => ({ id: index + 2, terminal }))
        }
      } as never,
      settingsRef: { current: { terminalFontSize: 14 } },
      updateSettings: vi.fn()
    })

    for (const listener of terminalZoomListeners) {
      listener('in')
    }

    expect(inactiveTerminal.options.fontSize).toBe(14)
    expect(activeTerminals.map((terminal) => terminal.options.fontSize)).toEqual([15, 15])
    expect(mocks.safeFit).toHaveBeenCalledTimes(2)
  })
})
