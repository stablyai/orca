// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetMacNativeTextInputSourceTrackerForTests,
  createMacNativeTextInputSourceTracker,
  getMacNativeTextInputSourceFeatures,
  getMacNativeTextInputSourceTracker
} from './terminal-ime-input-source'

describe('getMacNativeTextInputSourceFeatures', () => {
  it('enables punctuation forwarding for Apple Chinese, Japanese and Korean input methods', () => {
    for (const sourceId of [
      'com.apple.inputmethod.SCIM.ITABC',
      'com.apple.inputmethod.TCIM.Pinyin',
      'com.apple.keylayout.PinyinKeyboard',
      'com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese',
      'com.apple.inputmethod.Korean.2SetKorean'
    ]) {
      expect(getMacNativeTextInputSourceFeatures(sourceId)).toEqual({
        forwardAsciiPunctuation: true,
        forwardShortTextReplacements: false
      })
    }
  })

  it('accepts common third-party CJK input source IDs', () => {
    expect(getMacNativeTextInputSourceFeatures('com.google.inputmethod.Japanese.base')).toEqual({
      forwardAsciiPunctuation: true,
      forwardShortTextReplacements: false
    })
    expect(getMacNativeTextInputSourceFeatures('com.sogou.inputmethod.sogou.pinyin')).toEqual({
      forwardAsciiPunctuation: true,
      forwardShortTextReplacements: false
    })
    expect(getMacNativeTextInputSourceFeatures('com.bytedance.inputmethod.Doubao')).toEqual({
      forwardAsciiPunctuation: true,
      forwardShortTextReplacements: false
    })
    expect(getMacNativeTextInputSourceFeatures('im.rime.inputmethod.Squirrel.Rime')).toEqual({
      forwardAsciiPunctuation: true,
      forwardShortTextReplacements: false
    })
  })

  it('enables short native replacement forwarding for Vietnamese input methods', () => {
    for (const sourceId of [
      'com.apple.inputmethod.Vietnamese',
      'com.apple.inputmethod.Vietnamese.Telex',
      'com.apple.inputmethod.Vietnamese.VNI',
      'org.unikey.inputmethod.Unikey'
    ]) {
      expect(getMacNativeTextInputSourceFeatures(sourceId)).toEqual({
        forwardAsciiPunctuation: false,
        forwardShortTextReplacements: true
      })
    }
  })

  it('rejects plain keyboard layouts and unrelated input methods', () => {
    const disabled = {
      forwardAsciiPunctuation: false,
      forwardShortTextReplacements: false
    }
    expect(getMacNativeTextInputSourceFeatures(null)).toEqual(disabled)
    expect(getMacNativeTextInputSourceFeatures('com.apple.keylayout.US')).toEqual(disabled)
    expect(getMacNativeTextInputSourceFeatures('com.apple.keylayout.ABC')).toEqual(disabled)
    expect(getMacNativeTextInputSourceFeatures('com.apple.keylayout.PolishPro')).toEqual(disabled)
    expect(getMacNativeTextInputSourceFeatures('com.apple.inputmethod.CharacterPaletteIM')).toEqual(
      disabled
    )
  })
})

describe('createMacNativeTextInputSourceTracker', () => {
  beforeEach(() => {
    _resetMacNativeTextInputSourceTrackerForTests()
  })

  afterEach(() => {
    _resetMacNativeTextInputSourceTrackerForTests()
  })

  it('starts disabled and refreshes from the current input source', async () => {
    let sourceId = 'com.apple.keylayout.US'
    const tracker = createMacNativeTextInputSourceTracker(window, {
      readInputSourceId: async () => sourceId
    })

    expect(tracker.isActive()).toBe(false)
    await tracker.refresh()
    expect(tracker.isActive()).toBe(false)
    expect(tracker.getFeatures()).toEqual({
      forwardAsciiPunctuation: false,
      forwardShortTextReplacements: false
    })

    sourceId = 'com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese'
    await tracker.refresh()
    expect(tracker.isActive()).toBe(true)
    expect(tracker.getFeatures()).toEqual({
      forwardAsciiPunctuation: true,
      forwardShortTextReplacements: false
    })

    sourceId = 'com.apple.inputmethod.Vietnamese.Telex'
    await tracker.refresh()
    expect(tracker.isActive()).toBe(true)
    expect(tracker.getFeatures()).toEqual({
      forwardAsciiPunctuation: false,
      forwardShortTextReplacements: true
    })

    tracker.dispose()
  })

  it('refreshes on window focus so language switches are picked up', async () => {
    let sourceId = 'com.apple.keylayout.US'
    const tracker = createMacNativeTextInputSourceTracker(window, {
      readInputSourceId: async () => sourceId
    })
    await tracker.refresh()

    sourceId = 'com.apple.inputmethod.TCIM.Pinyin'
    window.dispatchEvent(new Event('focus'))

    await vi.waitFor(() => expect(tracker.isActive()).toBe(true))
    tracker.dispose()
  })

  it('refreshes on keydown so focused input source switches are picked up', async () => {
    let sourceId = 'com.apple.keylayout.ABC'
    const tracker = createMacNativeTextInputSourceTracker(window, {
      readInputSourceId: async () => sourceId
    })
    await tracker.refresh()
    expect(tracker.isActive()).toBe(false)

    sourceId = 'com.apple.inputmethod.SCIM.ITABC'
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd' }))

    await vi.waitFor(() =>
      expect(tracker.getFeatures()).toEqual({
        forwardAsciiPunctuation: true,
        forwardShortTextReplacements: false
      })
    )
    tracker.dispose()
  })

  it('throttles ordinary key refreshes while input-source features are disabled', async () => {
    let sourceId = 'com.apple.keylayout.ABC'
    const readInputSourceId = vi.fn(async () => sourceId)
    const tracker = createMacNativeTextInputSourceTracker(window, { readInputSourceId })
    await tracker.refresh()
    readInputSourceId.mockClear()

    const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
    try {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
      await vi.waitFor(() => expect(readInputSourceId).toHaveBeenCalledTimes(1))

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b' }))
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'b' }))
      await Promise.resolve()
      expect(readInputSourceId).toHaveBeenCalledTimes(1)

      sourceId = 'com.apple.inputmethod.SCIM.ITABC'
      now.mockReturnValue(2001)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c' }))
      await vi.waitFor(() => expect(readInputSourceId).toHaveBeenCalledTimes(2))
      expect(tracker.isActive()).toBe(true)
    } finally {
      now.mockRestore()
      tracker.dispose()
    }
  })

  it('refreshes on modifier keyup so active sources can become disabled while focused', async () => {
    let sourceId = 'com.apple.inputmethod.SCIM.ITABC'
    const tracker = createMacNativeTextInputSourceTracker(window, {
      readInputSourceId: async () => sourceId
    })
    await tracker.refresh()
    expect(tracker.isActive()).toBe(true)

    sourceId = 'com.apple.keylayout.ABC'
    window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', ctrlKey: true }))

    await vi.waitFor(() => expect(tracker.isActive()).toBe(false))
    tracker.dispose()
  })

  it('keeps the singleton reusable for terminal lifecycle code', () => {
    const first = getMacNativeTextInputSourceTracker()
    const second = getMacNativeTextInputSourceTracker()

    expect(second).toBe(first)
  })
})
