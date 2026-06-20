import { afterEach, describe, expect, it, vi } from 'vitest'

import { extractAllOscTitles, extractLastOscTitle, MAX_OSC_TITLE_CHARS } from './agent-detection'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('OSC title extraction', () => {
  it('extracts the last OSC title from BEL-terminated PTY data', () => {
    expect(extractLastOscTitle('\x1b]0;First\x07noise\x1b]2;Second\x07')).toBe('Second')
  })

  it('extracts all OSC titles including ST-terminated titles', () => {
    expect(extractAllOscTitles('\x1b]0;First\x1b\\noise\x1b]2;Second\x07')).toEqual([
      'First',
      'Second'
    ])
  })

  it('ignores incomplete OSC titles until a later chunk supplies the terminator', () => {
    expect(extractAllOscTitles('\x1b]0;Incomplete title')).toEqual([])
    expect(extractLastOscTitle('\x1b]0;Incomplete title')).toBeNull()
  })

  it('recovers when an abandoned incomplete OSC title is followed by a fresh title', () => {
    const data = '\x1b]0;abandoned\x1b]0;Fresh title\x07'

    expect(extractLastOscTitle(data)).toBe('Fresh title')
    expect(extractAllOscTitles(data)).toEqual(['Fresh title'])
  })

  it('scans large PTY chunks without regex match iteration', () => {
    const matchAll = vi.spyOn(String.prototype, 'matchAll')
    const data = `${'pasted terminal noise \x1b]x;ignored\x07 '.repeat(10_000)}\x1b]0;Agent working\x07`

    expect(extractLastOscTitle(data)).toBe('Agent working')
    expect(extractAllOscTitles(data).at(-1)).toBe('Agent working')
    expect(matchAll).not.toHaveBeenCalled()
  })

  it('caps oversized OSC titles before downstream title processing', () => {
    const title = `${'a'.repeat(MAX_OSC_TITLE_CHARS)}${'b'.repeat(10_000)}`
    const data = `before\x1b]0;${title}\x07after`

    const extracted = extractLastOscTitle(data)

    expect(extracted).toHaveLength(MAX_OSC_TITLE_CHARS)
    expect(extracted?.startsWith('a'.repeat(MAX_OSC_TITLE_CHARS / 2))).toBe(true)
    expect(extracted?.endsWith('b'.repeat(MAX_OSC_TITLE_CHARS / 2))).toBe(true)
    expect(extractAllOscTitles(data)).toEqual([extracted])
  })
})
