import { describe, expect, it } from 'vitest'
import { resolveLeftTitlebarChromeLayout } from './titlebar-left-chrome'

describe('resolveLeftTitlebarChromeLayout', () => {
  it('mounts in normal workspace chrome', () => {
    expect(
      resolveLeftTitlebarChromeLayout({
        workspaceChromeActive: true,
        stackedSidebarOpen: false,
        creationLayoutActive: false,
        sidebarOpen: true
      })
    ).toEqual({ shouldMount: true, isFloating: false })
  })

  it('mounts for stacked sidebar pages without floating', () => {
    expect(
      resolveLeftTitlebarChromeLayout({
        workspaceChromeActive: false,
        stackedSidebarOpen: true,
        creationLayoutActive: false,
        sidebarOpen: true
      })
    ).toEqual({ shouldMount: true, isFloating: false })
  })

  it('preserves the left titlebar chrome during visible worktree creation', () => {
    expect(
      resolveLeftTitlebarChromeLayout({
        workspaceChromeActive: false,
        stackedSidebarOpen: false,
        creationLayoutActive: true,
        sidebarOpen: true
      })
    ).toEqual({ shouldMount: true, isFloating: false })
  })

  it('floats during creation when the sidebar is collapsed', () => {
    expect(
      resolveLeftTitlebarChromeLayout({
        workspaceChromeActive: false,
        stackedSidebarOpen: false,
        creationLayoutActive: true,
        sidebarOpen: false
      })
    ).toEqual({ shouldMount: true, isFloating: true })
  })

  it('stays unmounted on full-width titlebar pages', () => {
    expect(
      resolveLeftTitlebarChromeLayout({
        workspaceChromeActive: false,
        stackedSidebarOpen: false,
        creationLayoutActive: false,
        sidebarOpen: false
      })
    ).toEqual({ shouldMount: false, isFloating: false })
  })
})
