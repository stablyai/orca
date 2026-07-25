// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  calibrateHostPointerOrigin,
  installWebviewPointerLeakCorrection,
  isGenuineHostPointerEnter,
  isLeakedGuestPointerEvent,
  resetHostPointerOriginForTests
} from './webview-leaked-pointer-guard'

// Captured from a real drag-select in a browser pane: window origin (459,25), webview origin (281,87).
const WINDOW_ORIGIN = { x: 459, y: 25 }
const WEBVIEW_ORIGIN = { x: 281, y: 87 }

function hostEvent(clientX: number, clientY: number, buttons = 0) {
  return {
    clientX,
    clientY,
    screenX: clientX + WINDOW_ORIGIN.x,
    screenY: clientY + WINDOW_ORIGIN.y,
    buttons
  }
}

/** A guest event handed to the host verbatim: client stays guest-local, screen stays correct. */
function leakedEvent(guestClientX: number, guestClientY: number, buttons = 0) {
  return {
    clientX: guestClientX,
    clientY: guestClientY,
    screenX: guestClientX + WINDOW_ORIGIN.x + WEBVIEW_ORIGIN.x,
    screenY: guestClientY + WINDOW_ORIGIN.y + WEBVIEW_ORIGIN.y,
    buttons
  }
}

describe('webview pointer leak detection', () => {
  afterEach(() => {
    resetHostPointerOriginForTests()
  })

  it('treats events as genuine until calibrated so hover never breaks', () => {
    expect(isLeakedGuestPointerEvent(leakedEvent(93, 155))).toBe(false)
  })

  it('flags the captured leak once calibrated from a host press', () => {
    calibrateHostPointerOrigin(hostEvent(186, 620), { authoritative: true })

    expect(isLeakedGuestPointerEvent(hostEvent(140, 60))).toBe(false)
    expect(isLeakedGuestPointerEvent(leakedEvent(129, 60))).toBe(true)
    expect(isLeakedGuestPointerEvent(leakedEvent(153, 184))).toBe(true)
  })

  it('needs two agreeing moves before trusting a new origin', () => {
    calibrateHostPointerOrigin(hostEvent(100, 100), { authoritative: true })
    const moved = { clientX: 100, clientY: 100, screenX: 700, screenY: 400, buttons: 0 }

    calibrateHostPointerOrigin(moved, { authoritative: false })
    // Why: a single disagreeing sample could be a leak, so the reference must not move yet.
    expect(isLeakedGuestPointerEvent(moved)).toBe(true)

    calibrateHostPointerOrigin(moved, { authoritative: false })
    expect(isLeakedGuestPointerEvent(moved)).toBe(false)
  })

  it('re-calibrates immediately from a press after the window moves', () => {
    calibrateHostPointerOrigin(hostEvent(100, 100), { authoritative: true })
    const afterWindowMove = { clientX: 100, clientY: 100, screenX: 900, screenY: 500, buttons: 0 }

    calibrateHostPointerOrigin(afterWindowMove, { authoritative: true })

    expect(isLeakedGuestPointerEvent(afterWindowMove)).toBe(false)
  })

  it('rejects hover intent for leaks and for held buttons, accepts real enters', () => {
    calibrateHostPointerOrigin(hostEvent(186, 620), { authoritative: true })

    expect(isGenuineHostPointerEnter(hostEvent(140, 60))).toBe(true)
    expect(isGenuineHostPointerEnter(leakedEvent(129, 60))).toBe(false)
    expect(isGenuineHostPointerEnter(hostEvent(140, 60, 1))).toBe(false)
  })
})

describe('installWebviewPointerLeakCorrection', () => {
  const clearStaleHoverState = vi.fn(() => Promise.resolve())

  beforeEach(() => {
    clearStaleHoverState.mockClear()
    Object.assign(window, { api: { ui: { clearStaleHoverState } } })
    document.body.innerHTML = '<div id="row" style="width:100px;height:20px">row</div>'
  })

  afterEach(() => {
    resetHostPointerOriginForTests()
    document.body.innerHTML = ''
  })

  function dispatch(type: string, sample: ReturnType<typeof hostEvent>): void {
    window.dispatchEvent(new MouseEvent(type, { ...sample, bubbles: true }))
  }

  it('asks the main process to drop hover when a leak lands on hovered UI', () => {
    const stop = installWebviewPointerLeakCorrection()
    dispatch('pointerdown', hostEvent(186, 620))
    // Why: happy-dom reports no :hover, so stand in for Blink's stale hover state.
    const querySelectorAll = vi
      .spyOn(document, 'querySelectorAll')
      .mockReturnValue([document.getElementById('row')] as unknown as NodeListOf<Element>)

    dispatch('pointerup', leakedEvent(129, 60))

    expect(clearStaleHoverState).toHaveBeenCalledTimes(1)
    querySelectorAll.mockRestore()
    stop()
  })

  it('leaves genuine events alone', () => {
    const stop = installWebviewPointerLeakCorrection()
    dispatch('pointerdown', hostEvent(186, 620))

    dispatch('pointerup', hostEvent(190, 615))
    dispatch('pointerover', hostEvent(140, 60))

    expect(clearStaleHoverState).not.toHaveBeenCalled()
    stop()
  })

  it('skips the round-trip when nothing is hovered', () => {
    const stop = installWebviewPointerLeakCorrection()
    dispatch('pointerdown', hostEvent(186, 620))

    dispatch('pointerup', leakedEvent(129, 60))

    expect(clearStaleHoverState).not.toHaveBeenCalled()
    stop()
  })
})
