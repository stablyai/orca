import { describe, expect, it } from 'vitest'
import { shouldFollowMouseFocus, type FocusFollowsMouseInput } from './focus-follows-mouse'

describe('shouldFollowMouseFocus', () => {
  // Base input where every gate passes. Individual tests flip one field
  // at a time to assert that each gate blocks focus independently.
  const base: FocusFollowsMouseInput = {
    featureEnabled: true,
    activePaneId: 1,
    hoveredPaneId: 2,
    mouseButtons: 0,
    windowHasFocus: true,
    managerDestroyed: false
  }

  it('switches focus when all gates pass', () => {
    expect(shouldFollowMouseFocus(base)).toBe(true)
  })

  it('blocks when the feature is disabled', () => {
    expect(shouldFollowMouseFocus({ ...base, featureEnabled: false })).toBe(false)
  })

  it('blocks when the manager is destroyed', () => {
    expect(shouldFollowMouseFocus({ ...base, managerDestroyed: true })).toBe(false)
  })

  it('blocks when hovering the already-active pane', () => {
    expect(shouldFollowMouseFocus({ ...base, hoveredPaneId: 1 })).toBe(false)
  })

  it('blocks while the primary mouse button is held (buttons=1)', () => {
    expect(shouldFollowMouseFocus({ ...base, mouseButtons: 1 })).toBe(false)
  })

  it('blocks while the secondary mouse button is held (buttons=2)', () => {
    expect(shouldFollowMouseFocus({ ...base, mouseButtons: 2 })).toBe(false)
  })

  it('blocks while multiple buttons are held (buttons=3)', () => {
    expect(shouldFollowMouseFocus({ ...base, mouseButtons: 3 })).toBe(false)
  })

  it('blocks when the window does not have OS focus', () => {
    expect(shouldFollowMouseFocus({ ...base, windowHasFocus: false })).toBe(false)
  })

  // Defensive case: createInitialPane always sets activePaneId before any
  // mouse events are possible in production, but the gate must still behave
  // correctly if the state ever occurs (e.g. future refactor of init flow).
  it('switches when activePaneId is null (defensive)', () => {
    expect(shouldFollowMouseFocus({ ...base, activePaneId: null })).toBe(true)
  })
})
