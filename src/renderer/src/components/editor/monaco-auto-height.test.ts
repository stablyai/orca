import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MONACO_AUTO_HEIGHT_LINE_SCAN_CODE_UNITS,
  MONACO_AUTO_HEIGHT_MAX_LINES,
  clampMonacoAutoHeight,
  getMonacoAutoHeightForContent,
  isMonacoAutoHeightCapped
} from './monaco-auto-height'

const LINE_HEIGHT = 20

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Monaco auto-height sizing', () => {
  it('preserves small-content height estimates including CRLF content', () => {
    expect(getMonacoAutoHeightForContent('', LINE_HEIGHT)).toBe(80)
    expect(getMonacoAutoHeightForContent('one line', LINE_HEIGHT)).toBe(80)
    expect(getMonacoAutoHeightForContent('one\ntwo', LINE_HEIGHT)).toBe(80)
    expect(getMonacoAutoHeightForContent('one\r\ntwo\r\nthree\r\nfour', LINE_HEIGHT)).toBe(98)
  })

  it('caps newline-heavy pasted content without splitting or walking the full payload', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const charCodeAt = vi.spyOn(String.prototype, 'charCodeAt')
    const height = getMonacoAutoHeightForContent('\n'.repeat(100_000), LINE_HEIGHT)

    expect(height).toBe(MONACO_AUTO_HEIGHT_MAX_LINES * LINE_HEIGHT + 18)
    expect(isMonacoAutoHeightCapped(height, LINE_HEIGHT)).toBe(true)
    expect(split).not.toHaveBeenCalled()
    expect(charCodeAt.mock.calls.length).toBe(MONACO_AUTO_HEIGHT_MAX_LINES - 1)
  })

  it('bounds long single-line scans used only for initial auto-height estimates', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const charCodeAt = vi.spyOn(String.prototype, 'charCodeAt')
    const content = 'x'.repeat(MONACO_AUTO_HEIGHT_LINE_SCAN_CODE_UNITS + 10_000)

    expect(getMonacoAutoHeightForContent(content, LINE_HEIGHT)).toBe(80)

    expect(split).not.toHaveBeenCalled()
    expect(charCodeAt.mock.calls.length).toBe(MONACO_AUTO_HEIGHT_LINE_SCAN_CODE_UNITS)
  })

  it('caps measured Monaco content height and identifies capped layouts', () => {
    const capped = clampMonacoAutoHeight(Number.MAX_SAFE_INTEGER, LINE_HEIGHT)

    expect(capped).toBe(MONACO_AUTO_HEIGHT_MAX_LINES * LINE_HEIGHT + 18)
    expect(isMonacoAutoHeightCapped(capped, LINE_HEIGHT)).toBe(true)
    expect(isMonacoAutoHeightCapped(80, LINE_HEIGHT)).toBe(false)
  })
})
