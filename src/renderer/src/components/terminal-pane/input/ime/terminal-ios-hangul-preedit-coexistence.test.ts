// @vitest-environment happy-dom
/**
 * What the iPadOS Hangul path must not disturb: the composition sessions other
 * input sources on the same device do run, non-Hangul scripts, desktop
 * platforms, and anything else that writes to the PTY.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  disposeOpenTerminals,
  dispatchComposition,
  dispatchKey,
  nextEventLoop,
  openIosTerminal,
  pretendIosWeb,
  typeHangeul
} from './terminal-ios-hangul-preedit-fixture'

describe('the iPadOS Hangul path alongside everything else', () => {
  let originalUserAgent: PropertyDescriptor | undefined
  let originalMaxTouchPoints: PropertyDescriptor | undefined

  beforeEach(() => {
    originalUserAgent = Object.getOwnPropertyDescriptor(navigator, 'userAgent')
    originalMaxTouchPoints = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints')
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    disposeOpenTerminals()
    if (originalUserAgent) {
      Object.defineProperty(navigator, 'userAgent', originalUserAgent)
    }
    if (originalMaxTouchPoints) {
      Object.defineProperty(navigator, 'maxTouchPoints', originalMaxTouchPoints)
    }
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('composes Hangul after a composition that never ended, then a blur', async () => {
    // Derive expiring composition state: a latched flag survives missing end/blur and can disable input forever.
    pretendIosWeb()
    const rig = openIosTerminal()
    dispatchComposition(rig, 'compositionstart', '')
    dispatchComposition(rig, 'compositionupdate', 'n')
    rig.textarea.dispatchEvent(new FocusEvent('blur', { bubbles: false }))
    rig.textarea.value = ''
    await nextEventLoop()

    await typeHangeul(rig)
    dispatchKey(rig, 'keydown', { key: 'Enter', code: 'Enter', keyCode: 13 })

    expect(rig.emitted.join('')).toContain('한글')
  })
})
