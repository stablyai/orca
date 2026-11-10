import { describe, expect, it } from 'vitest'
import {
  canShowRightSidebarForView,
  showsFloatingRightSidebarToggle
} from './right-sidebar-visibility'

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

describe('canShowRightSidebarForView', () => {
  it('keeps the auxiliary sidebar out of plugin main pages', () => {
    expect(canShowRightSidebarForView('plugin:samples.one/dashboard')).toBe(false)
    expect(canShowRightSidebarForView('terminal')).toBe(true)
  })
})
