import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  macTrafficLightChromeForWindow,
  macTrafficLightsWidth,
  shouldRenderDesktopWindowChrome,
  shouldShowMacTrafficLightPad
} from './desktop-window-chrome'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('shouldRenderDesktopWindowChrome', () => {
  it('renders custom chrome for frameless desktop Linux and Windows windows', () => {
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

describe('mac traffic-light inset', () => {
  it('reserves the inset on desktop macOS, including while fullscreen hides the pad', () => {
    expect(macTrafficLightsWidth({ isMac: true, isWebClient: false })).toBe('80px')
    expect(
      shouldShowMacTrafficLightPad({ isMac: true, isWebClient: false, isFullScreen: false })
    ).toBe(true)
    expect(
      shouldShowMacTrafficLightPad({ isMac: true, isWebClient: false, isFullScreen: true })
    ).toBe(false)
  })

  it('does not reserve a traffic-light inset in the paired web client on a Mac', () => {
    expect(macTrafficLightsWidth({ isMac: true, isWebClient: true })).toBe('0px')
    expect(
      shouldShowMacTrafficLightPad({ isMac: true, isWebClient: true, isFullScreen: false })
    ).toBe(false)
    expect(
      shouldShowMacTrafficLightPad({ isMac: true, isWebClient: true, isFullScreen: true })
    ).toBe(false)
  })

  it('reads the paired web flag for both the inset width and the pad', () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    expect(macTrafficLightChromeForWindow({ isMac: true, isFullScreen: false })).toEqual({
      width: '0px',
      showPad: false
    })

    vi.stubGlobal('__ORCA_WEB_CLIENT__', false)
    expect(macTrafficLightChromeForWindow({ isMac: true, isFullScreen: false })).toEqual({
      width: '80px',
      showPad: true
    })
  })

  it('does not reserve a traffic-light inset on Windows or Linux', () => {
    expect(macTrafficLightsWidth({ isMac: false, isWebClient: false })).toBe('0px')
    expect(
      shouldShowMacTrafficLightPad({ isMac: false, isWebClient: false, isFullScreen: false })
    ).toBe(false)
  })
})
