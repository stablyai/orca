import { describe, expect, it } from 'vitest'
import { isIosWebPlatform } from './ios-web-platform'

const IPAD_DESKTOP_MODE_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
const IPAD_MOBILE_MODE_UA =
  'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1'
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const IPOD_UA =
  'Mozilla/5.0 (iPod touch; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Mobile/15E148 Safari/604.1'
const MAC_DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const MAC_ELECTRON_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) orca/1.0.0 Chrome/126.0.0.0 Electron/31.0.0 Safari/537.36'
const WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'

describe('isIosWebPlatform', () => {
  it('detects iPadOS desktop mode, which reports Macintosh and omits iPad', () => {
    expect(isIosWebPlatform(IPAD_DESKTOP_MODE_UA, 5)).toBe(true)
  })

  it('detects iPad, iPhone and iPod mobile-mode user agents', () => {
    expect(isIosWebPlatform(IPAD_MOBILE_MODE_UA, 5)).toBe(true)
    expect(isIosWebPlatform(IPHONE_UA, 5)).toBe(true)
    expect(isIosWebPlatform(IPOD_UA, 5)).toBe(true)
  })

  it('detects a mobile-mode iPad even when the touch count is unavailable', () => {
    expect(isIosWebPlatform(IPAD_MOBILE_MODE_UA, 0)).toBe(true)
  })

  it('does not claim a Mac browser or the Electron app', () => {
    expect(isIosWebPlatform(MAC_DESKTOP_UA, 0)).toBe(false)
    expect(isIosWebPlatform(MAC_ELECTRON_UA, 0)).toBe(false)
  })

  it('does not claim a Mac whose touch peripheral reports a single point', () => {
    expect(isIosWebPlatform(MAC_DESKTOP_UA, 1)).toBe(false)
  })

  it('does not claim Windows, Linux or Android', () => {
    expect(isIosWebPlatform(WINDOWS_UA, 0)).toBe(false)
    expect(isIosWebPlatform(ANDROID_UA, 5)).toBe(false)
  })
})
