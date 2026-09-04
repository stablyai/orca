// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import { useSessionGridKeyboardNavigation } from './use-session-grid-keyboard-navigation'

function pressOn(target: EventTarget, key: string, init: KeyboardEventInit = {}): void {
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  )
}

describe('useSessionGridKeyboardNavigation', () => {
  beforeEach(() => {
    useAppStore.setState({ keybindings: {} })
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  function mount(): { scrollToPosition: ReturnType<typeof vi.fn> } {
    const scrollToPosition = vi.fn()
    renderHook(() =>
      useSessionGridKeyboardNavigation({ currentPositionRef: { current: 2 }, scrollToPosition })
    )
    return { scrollToPosition }
  }

  it('moves one step from the current position on PageDown and PageUp', () => {
    const { scrollToPosition } = mount()
    pressOn(document.body, 'PageDown')
    pressOn(document.body, 'PageUp')
    expect(scrollToPosition.mock.calls).toEqual([[3], [1]])
  })

  it('also steps on Alt+Arrow, the secondary default', () => {
    const { scrollToPosition } = mount()
    pressOn(document.body, 'ArrowDown', { altKey: true })
    pressOn(document.body, 'ArrowUp', { altKey: true })
    expect(scrollToPosition.mock.calls).toEqual([[3], [1]])
  })

  it('honours a user rebinding instead of the defaults', () => {
    useAppStore.setState({
      keybindings: { 'sessions.grid.nextPage': ['Alt+N'], 'sessions.grid.prevPage': [] }
    })
    const { scrollToPosition } = mount()
    pressOn(document.body, 'PageDown')
    pressOn(document.body, 'PageUp')
    expect(scrollToPosition).not.toHaveBeenCalled()
    pressOn(document.body, 'n', { code: 'KeyN', altKey: true })
    expect(scrollToPosition.mock.calls).toEqual([[3]])
  })

  it('leaves PageDown to a focused terminal', () => {
    const { scrollToPosition } = mount()
    const helper = document.createElement('textarea')
    helper.className = 'xterm-helper-textarea'
    document.body.appendChild(helper)
    pressOn(helper, 'PageDown')
    expect(scrollToPosition).not.toHaveBeenCalled()
  })

  it('leaves PageDown to a focused input', () => {
    const { scrollToPosition } = mount()
    const input = document.createElement('input')
    document.body.appendChild(input)
    pressOn(input, 'PageDown')
    expect(scrollToPosition).not.toHaveBeenCalled()
  })

  it('ignores key repeat, which used to queue smooth scrolls that fought each other', () => {
    const { scrollToPosition } = mount()
    pressOn(document.body, 'PageDown', { repeat: true })
    expect(scrollToPosition).not.toHaveBeenCalled()
  })
})
