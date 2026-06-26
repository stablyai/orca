// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetMacCjkInputSourceTrackerForTests,
  createMacCjkInputSourceTracker,
  getMacCjkInputSourceTracker,
  isMacCjkInputSourceId
} from './terminal-ime-input-source'

describe('isMacCjkInputSourceId', () => {
  it('accepts Apple Chinese, Japanese and Korean input methods', () => {
    expect(isMacCjkInputSourceId('com.apple.inputmethod.SCIM.ITABC')).toBe(true)
    expect(isMacCjkInputSourceId('com.apple.inputmethod.TCIM.Pinyin')).toBe(true)
    expect(isMacCjkInputSourceId('com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese')).toBe(true)
    expect(isMacCjkInputSourceId('com.apple.inputmethod.Korean.2SetKorean')).toBe(true)
  })

  it('accepts common third-party CJK input source IDs', () => {
    expect(isMacCjkInputSourceId('com.google.inputmethod.Japanese.base')).toBe(true)
    expect(isMacCjkInputSourceId('com.sogou.inputmethod.sogou.pinyin')).toBe(true)
    expect(isMacCjkInputSourceId('im.rime.inputmethod.Squirrel.Rime')).toBe(true)
  })

  it('rejects plain keyboard layouts and non-CJK input methods', () => {
    expect(isMacCjkInputSourceId(null)).toBe(false)
    expect(isMacCjkInputSourceId('com.apple.keylayout.US')).toBe(false)
    expect(isMacCjkInputSourceId('com.apple.keylayout.ABC')).toBe(false)
    expect(isMacCjkInputSourceId('com.apple.keylayout.PolishPro')).toBe(false)
    expect(isMacCjkInputSourceId('com.apple.inputmethod.CharacterPaletteIM')).toBe(false)
    expect(isMacCjkInputSourceId('com.apple.inputmethod.Vietnamese')).toBe(false)
  })
})

describe('createMacCjkInputSourceTracker', () => {
  beforeEach(() => {
    _resetMacCjkInputSourceTrackerForTests()
  })

  afterEach(() => {
    _resetMacCjkInputSourceTrackerForTests()
  })

  it('starts disabled and refreshes from the current input source', async () => {
    let sourceId = 'com.apple.keylayout.US'
    const tracker = createMacCjkInputSourceTracker(window, {
      readInputSourceId: async () => sourceId
    })

    expect(tracker.isActive()).toBe(false)
    await tracker.refresh()
    expect(tracker.isActive()).toBe(false)

    sourceId = 'com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese'
    await tracker.refresh()
    expect(tracker.isActive()).toBe(true)

    tracker.dispose()
  })

  it('refreshes on window focus so language switches are picked up', async () => {
    let sourceId = 'com.apple.keylayout.US'
    const tracker = createMacCjkInputSourceTracker(window, {
      readInputSourceId: async () => sourceId
    })
    await tracker.refresh()

    sourceId = 'com.apple.inputmethod.TCIM.Pinyin'
    window.dispatchEvent(new Event('focus'))

    await vi.waitFor(() => expect(tracker.isActive()).toBe(true))
    tracker.dispose()
  })

  it('keeps the singleton reusable for terminal lifecycle code', () => {
    const first = getMacCjkInputSourceTracker()
    const second = getMacCjkInputSourceTracker()

    expect(second).toBe(first)
  })
})
