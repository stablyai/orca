import { describe, expect, it } from 'vitest'
import { isIosWebPlatform } from '../app-shell/platform/ios-web-platform'
import { isTabletViewport } from './web-tablet-layout'

describe('web tablet layout', () => {
  it('treats an iPad UA as tablet at any width', () => {
    const ipad = isIosWebPlatform('iPad', 0)
    expect(ipad).toBe(true)
    expect(isTabletViewport({ width: 320, coarsePointer: false, ipad })).toBe(true)
  })

  it('treats iPadOS desktop-mode Safari, which reports Macintosh, as tablet', () => {
    const ipad = isIosWebPlatform('Macintosh Intel Mac OS X', 5)
    expect(ipad).toBe(true)
    expect(isTabletViewport({ width: 834, coarsePointer: false, ipad })).toBe(true)
  })

  it('ignores real Macs without touch', () => {
    const ipad = isIosWebPlatform('Macintosh Intel Mac OS X', 0)
    expect(ipad).toBe(false)
    expect(isTabletViewport({ width: 834, coarsePointer: false, ipad })).toBe(false)
  })

  it('treats coarse pointers at pad width as tablet', () => {
    expect(isTabletViewport({ width: 834, coarsePointer: true, ipad: false })).toBe(true)
  })

  it('ignores narrow phones even with touch', () => {
    expect(isTabletViewport({ width: 390, coarsePointer: true, ipad: false })).toBe(false)
  })

  it('ignores fine-pointer desktops', () => {
    expect(isTabletViewport({ width: 1440, coarsePointer: false, ipad: false })).toBe(false)
  })

  it('keeps iPad tablet regardless of width', () => {
    expect(isTabletViewport({ width: 320, coarsePointer: false, ipad: true })).toBe(true)
  })
})
