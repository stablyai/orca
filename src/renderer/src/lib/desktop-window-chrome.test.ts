import { describe, expect, it } from 'vitest'
import {
  resolveWindowControlsWidth,
  shouldRenderCustomWindowControls,
  shouldRenderDesktopWindowChrome
} from './desktop-window-chrome'

describe('shouldRenderDesktopWindowChrome', () => {
  it('reserves custom titlebar content for desktop Linux and Windows windows', () => {
    expect(shouldRenderDesktopWindowChrome({ platform: 'linux', isWebClient: false })).toBe(true)
    expect(shouldRenderDesktopWindowChrome({ platform: 'win32', isWebClient: false })).toBe(true)
  })

  it('keeps macOS on native traffic lights', () => {
    expect(shouldRenderDesktopWindowChrome({ platform: 'darwin', isWebClient: false })).toBe(false)
  })

  it('does not render desktop-only window controls in the paired web client', () => {
    expect(shouldRenderDesktopWindowChrome({ platform: 'linux', isWebClient: true })).toBe(false)
    expect(shouldRenderDesktopWindowChrome({ platform: 'win32', isWebClient: true })).toBe(false)
  })
})

describe('shouldRenderCustomWindowControls', () => {
  it('uses renderer controls only for frameless Linux', () => {
    expect(shouldRenderCustomWindowControls({ platform: 'linux', isWebClient: false })).toBe(true)
    expect(shouldRenderCustomWindowControls({ platform: 'win32', isWebClient: false })).toBe(false)
    expect(shouldRenderCustomWindowControls({ platform: 'darwin', isWebClient: false })).toBe(false)
  })

  it('does not render desktop controls in the paired web client', () => {
    expect(shouldRenderCustomWindowControls({ platform: 'linux', isWebClient: true })).toBe(false)
  })
})

describe('resolveWindowControlsWidth', () => {
  it('keeps native Windows controls fixed-width across UI zoom', () => {
    expect(resolveWindowControlsWidth({ platform: 'win32', isWebClient: false })).toBe(
      'calc(138px / var(--ui-zoom-factor, 1))'
    )
  })

  it('keeps renderer controls in the zoomed Linux layout', () => {
    expect(resolveWindowControlsWidth({ platform: 'linux', isWebClient: false })).toBe('138px')
  })

  it('does not reserve controls outside custom desktop chrome', () => {
    expect(resolveWindowControlsWidth({ platform: 'darwin', isWebClient: false })).toBe('0px')
    expect(resolveWindowControlsWidth({ platform: 'win32', isWebClient: true })).toBe('0px')
  })
})
