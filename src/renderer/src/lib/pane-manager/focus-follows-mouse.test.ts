import { describe, expect, it } from 'vitest'
import { shouldFollowMouseFocus, type FocusFollowsMouseInput } from './focus-follows-mouse'

describe('shouldFollowMouseFocus', () => {
  // Start with every gate passing, then change one field to isolate each focus veto.
  const base: FocusFollowsMouseInput = {
    featureEnabled: true,
    activePaneId: 1,
    hoveredPaneId: 2,
    focusInOtherPane: false,
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

  it('refocuses the already-active pane when focus is in another manager pane', () => {
    expect(shouldFollowMouseFocus({ ...base, hoveredPaneId: 1, focusInOtherPane: true })).toBe(true)
  })

  it('blocks while the primary mouse button is held (buttons=1)', () => {
    expect(shouldFollowMouseFocus({ ...base, mouseButtons: 1 })).toBe(false)
  })

  it('blocks while the secondary mouse button is held (buttons=2)', () => {
    expect(shouldFollowMouseFocus({ ...base, mouseButtons: 2 })).toBe(false)
  })

  it('blocks when the window does not have OS focus', () => {
    expect(shouldFollowMouseFocus({ ...base, windowHasFocus: false })).toBe(false)
  })
})
