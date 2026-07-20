import { describe, expect, it } from 'vitest'
import { isStatusBarItemSupportedOnPlatform } from './status-bar-platform-support'

describe('status bar platform support', () => {
  it('limits local Apple Music and Spotify status to macOS', () => {
    expect(isStatusBarItemSupportedOnPlatform('media-playback', 'darwin')).toBe(true)
    expect(isStatusBarItemSupportedOnPlatform('media-playback', 'linux')).toBe(false)
    expect(isStatusBarItemSupportedOnPlatform('media-playback', 'win32')).toBe(false)
  })

  it('keeps cross-platform status items available', () => {
    expect(isStatusBarItemSupportedOnPlatform('ports', 'linux')).toBe(true)
    expect(isStatusBarItemSupportedOnPlatform('resource-usage', 'win32')).toBe(true)
  })
})
