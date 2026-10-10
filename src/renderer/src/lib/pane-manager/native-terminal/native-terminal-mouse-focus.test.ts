import { describe, expect, it, vi } from 'vitest'
import { followNativePaneMouseFocus } from './native-terminal-mouse-focus'

function makeManager(activePaneId: number) {
  return {
    getActivePane: () => ({ id: activePaneId }),
    setActivePane: vi.fn()
  }
}

describe('followNativePaneMouseFocus', () => {
  it('activates and focuses the hovered pane when the setting is on and nothing is held', () => {
    const manager = makeManager(1)
    followNativePaneMouseFocus(manager, 2, { mouseButtons: 0, windowHasFocus: true }, true)
    expect(manager.setActivePane).toHaveBeenCalledWith(2, { focus: true })
  })

  it.each([
    ['the setting is off', 2, { mouseButtons: 0, windowHasFocus: true }, false],
    ['the pane is already active', 1, { mouseButtons: 0, windowHasFocus: true }, true],
    ['a button is held', 2, { mouseButtons: 1, windowHasFocus: true }, true],
    ['the window is not focused', 2, { mouseButtons: 0, windowHasFocus: false }, true]
  ])('does nothing when %s', (_label, hoveredPaneId, pointer, enabled) => {
    const manager = makeManager(1)
    followNativePaneMouseFocus(manager, hoveredPaneId, pointer, enabled)
    expect(manager.setActivePane).not.toHaveBeenCalled()
  })
})
