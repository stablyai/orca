import { afterEach, describe, expect, it, vi } from 'vitest'
import { isScreenSubmitShortcut } from './screen-submit-shortcut'

function setUserAgent(userAgent: string): void {
  vi.stubGlobal('navigator', { userAgent })
}

describe('screen submit shortcut', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('ignores composing Enter events', () => {
    setUserAgent('Linux')

    expect(isScreenSubmitShortcut({ key: 'Enter', ctrlKey: true, isComposing: true })).toBe(false)
    expect(
      isScreenSubmitShortcut({
        key: 'Enter',
        ctrlKey: true,
        nativeEvent: { isComposing: true }
      })
    ).toBe(false)
  })

  it.each(['Macintosh', 'Linux', 'Windows NT'])(
    'ignores keyCode-only IME chords on %s',
    (platform) => {
      setUserAgent(platform)
      const chord = {
        key: 'Enter',
        metaKey: platform === 'Macintosh',
        ctrlKey: platform !== 'Macintosh'
      }
      expect(isScreenSubmitShortcut({ ...chord, keyCode: 229 })).toBe(false)
      expect(isScreenSubmitShortcut({ ...chord, nativeEvent: { keyCode: 229 } })).toBe(false)
      expect(isScreenSubmitShortcut(chord)).toBe(true)
    }
  )
})
