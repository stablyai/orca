import { describe, expect, it } from 'vitest'
import { BrowserHistoryGesture } from './browser-history-gesture'

describe('BrowserHistoryGesture', () => {
  it('requires a native gesture and navigates only once until the next begin', () => {
    const gesture = new BrowserHistoryGesture()
    const wheel = { gestureId: 0, deltaX: -60, deltaY: 0, blocked: false }
    expect(gesture.record(wheel)).toBeNull()
    wheel.gestureId = gesture.begin()
    expect(gesture.record(wheel)).toBeNull()
    expect(gesture.record(wheel)).toBe('back')
    expect(gesture.record({ ...wheel, deltaX: -200 })).toBeNull()
    const next = gesture.begin()
    expect(gesture.record({ ...wheel, gestureId: next, deltaX: 120 })).toBe('forward')
  })

  it('rejects delayed samples from an ended or replaced gesture', () => {
    const gesture = new BrowserHistoryGesture()
    const old = gesture.begin()
    gesture.end()
    expect(gesture.record({ gestureId: old, deltaX: -200, deltaY: 0, blocked: false })).toBeNull()
    const current = gesture.begin()
    expect(gesture.record({ gestureId: old, deltaX: -200, deltaY: 0, blocked: false })).toBeNull()
    expect(gesture.record({ gestureId: current, deltaX: 110, deltaY: 1, blocked: false })).toBe(
      'forward'
    )
  })

  it('does not reuse tokens when a guest registration is replaced', () => {
    const old = new BrowserHistoryGesture().begin()
    const replacement = new BrowserHistoryGesture()
    replacement.begin()
    expect(
      replacement.record({ gestureId: old, deltaX: -200, deltaY: 0, blocked: false })
    ).toBeNull()
  })

  it('keeps the entire gesture owned by a page scroller even after it reaches an edge', () => {
    const gesture = new BrowserHistoryGesture()
    const gestureId = gesture.begin()
    expect(gesture.record({ gestureId, deltaX: -5, deltaY: 0, blocked: true })).toBeNull()
    expect(gesture.record({ gestureId, deltaX: -250, deltaY: 0, blocked: false })).toBeNull()
  })

  it('does not turn vertical scrolling into navigation after changing direction', () => {
    const gesture = new BrowserHistoryGesture()
    const gestureId = gesture.begin()
    expect(gesture.record({ gestureId, deltaX: 1, deltaY: 20, blocked: false })).toBeNull()
    expect(gesture.record({ gestureId, deltaX: -250, deltaY: 0, blocked: false })).toBeNull()
  })

  it('accounts for direction reversals instead of adding absolute horizontal distance', () => {
    const gesture = new BrowserHistoryGesture()
    const gestureId = gesture.begin()
    expect(gesture.record({ gestureId, deltaX: -70, deltaY: 0, blocked: false })).toBeNull()
    expect(gesture.record({ gestureId, deltaX: 50, deltaY: 0, blocked: false })).toBeNull()
    expect(gesture.record({ gestureId, deltaX: -80, deltaY: 0, blocked: false })).toBe('back')
  })
})
