import { afterEach, expect, it, vi } from 'vitest'
import { isTerminalLinkFloatingActivation } from './terminal-link-activation'

afterEach(() => vi.unstubAllGlobals())

it.each(['Macintosh', 'Windows', 'Linux'])(
  'claims only the exact floating left-click chord on %s',
  (userAgent) => {
    vi.stubGlobal('navigator', { userAgent })
    const chord = {
      button: 0,
      ctrlKey: userAgent !== 'Macintosh',
      metaKey: userAgent === 'Macintosh',
      altKey: true,
      shiftKey: false
    }
    expect(isTerminalLinkFloatingActivation(chord)).toBe(true)
    for (const change of [
      { button: 1 },
      { button: 2 },
      { shiftKey: true },
      { altKey: false },
      { ctrlKey: false, metaKey: false },
      { ctrlKey: true, metaKey: true },
      { ctrlKey: chord.metaKey, metaKey: chord.ctrlKey }
    ]) {
      expect(isTerminalLinkFloatingActivation({ ...chord, ...change })).toBe(false)
    }
  }
)
