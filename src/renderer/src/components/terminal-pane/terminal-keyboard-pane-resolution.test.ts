// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import {
  resolveTerminalKeyboardPane,
  synchronizeTerminalKeyboardPane
} from './terminal-keyboard-pane-resolution'

function pane(id: number): {
  id: number
  leafId: string
  terminal: { element: HTMLElement }
} {
  return {
    id,
    leafId: `leaf-${id}`,
    terminal: { element: document.createElement('div') }
  }
}

describe('resolveTerminalKeyboardPane', () => {
  it('uses the pane containing the event target when manager active state is stale', () => {
    const active = pane(1)
    const focused = pane(2)
    const input = document.createElement('textarea')
    focused.terminal.element.appendChild(input)
    const manager = {
      getActivePane: vi.fn(() => active),
      getPanes: vi.fn(() => [active, focused])
    }

    expect(resolveTerminalKeyboardPane(manager as never, input)).toBe(focused)
    expect(manager.getActivePane).not.toHaveBeenCalled()
  })

  it('falls back to the manager active pane for non-terminal shortcuts', () => {
    const active = pane(1)
    const manager = {
      getActivePane: vi.fn(() => active),
      getPanes: vi.fn(() => [active])
    }

    expect(resolveTerminalKeyboardPane(manager as never, document.body)).toBe(active)
  })

  it('repairs stale active state without stealing DOM focus', () => {
    const active = pane(1)
    const focused = pane(2)
    const input = document.createElement('textarea')
    focused.terminal.element.appendChild(input)
    let activePane = active
    const setActivePane = vi.fn((id: number) => {
      activePane = id === focused.id ? focused : active
    })
    const manager = {
      getActivePane: vi.fn(() => activePane),
      getPanes: vi.fn(() => [active, focused]),
      setActivePane
    }

    expect(synchronizeTerminalKeyboardPane(manager as never, input)).toBe(focused)
    expect(setActivePane).toHaveBeenCalledWith(focused.id, { focus: false })
    expect(activePane).toBe(focused)
  })
})
