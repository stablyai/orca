import { describe, expect, it } from 'vitest'
import { resolveSidebarDrawerLeftEdge } from './sidebar-drawer-left-edge'

describe('resolveSidebarDrawerLeftEdge', () => {
  it('keeps the list edge unchanged without the app rail', () => {
    expect(
      resolveSidebarDrawerLeftEdge({ sidebarOpen: true, sidebarWidth: 280, railWidth: 0 })
    ).toEqual({
      left: 280,
      leftCss: 'var(--workspace-sidebar-live-width, 280px)'
    })
    expect(
      resolveSidebarDrawerLeftEdge({ sidebarOpen: false, sidebarWidth: 280, railWidth: 0 })
    ).toEqual({
      left: 0,
      leftCss: '0px'
    })
  })

  it('starts right of the app rail with the list open or collapsed', () => {
    expect(
      resolveSidebarDrawerLeftEdge({ sidebarOpen: true, sidebarWidth: 280, railWidth: 40 })
    ).toEqual({
      left: 320,
      leftCss: 'calc(40px + var(--workspace-sidebar-live-width, 280px))'
    })
    expect(
      resolveSidebarDrawerLeftEdge({ sidebarOpen: false, sidebarWidth: 280, railWidth: 40 })
    ).toEqual({
      left: 40,
      leftCss: '40px'
    })
  })
})
