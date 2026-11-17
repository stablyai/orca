import { describe, expect, it, vi } from 'vitest'
import { returnFocusToWorkspace } from './cloud-focus-return'

// Identity is all the helper compares, so plain objects stand in for DOM nodes.
const body = {}

describe('returnFocusToWorkspace (waking overlay → null)', () => {
  it('gives focus back to the active tab when the cover took it with it to <body>', () => {
    const focusTab = vi.fn()
    expect(returnFocusToWorkspace('tab-1', focusTab, { activeElement: body, body })).toBe(true)
    expect(focusTab).toHaveBeenCalledWith('tab-1')
  })

  it('treats no active element as dropped focus too', () => {
    const focusTab = vi.fn()
    expect(returnFocusToWorkspace('tab-1', focusTab, { activeElement: null, body })).toBe(true)
  })

  it('never steals focus the user moved elsewhere, and needs an active tab', () => {
    const focusTab = vi.fn()
    const sidebarButton = {}
    expect(returnFocusToWorkspace('tab-1', focusTab, { activeElement: sidebarButton, body })).toBe(
      false
    )
    expect(returnFocusToWorkspace(null, focusTab, { activeElement: body, body })).toBe(false)
    expect(focusTab).not.toHaveBeenCalled()
  })
})
