import { describe, expect, it } from 'vitest'
import { showsFloatingRightSidebarToggle } from './right-sidebar-visibility'

describe('showsFloatingRightSidebarToggle', () => {
  it('keeps a way to reopen the closed sidebar during workspace creation', () => {
    expect(
      showsFloatingRightSidebarToggle({
        activeView: 'terminal',
        workspaceChromeActive: false,
        creationLayoutActive: true,
        rightSidebarOpen: false
      })
    ).toBe(true)
  })

  it('leaves the open sidebar to its own close button', () => {
    expect(
      showsFloatingRightSidebarToggle({
        activeView: 'terminal',
        workspaceChromeActive: false,
        creationLayoutActive: true,
        rightSidebarOpen: true
      })
    ).toBe(false)
  })
})
