import { describe, expect, it } from 'vitest'
import { extractAllOscTitles, extractLastOscTitle } from './osc-title-extraction'

describe('OSC title extraction', () => {
  it('recovers when an abandoned incomplete OSC title is followed by a fresh title', () => {
    const data = '\x1b]0;abandoned\x1b]0;Fresh title\x07'

    expect(extractLastOscTitle(data)).toBe('Fresh title')
    expect(extractAllOscTitles(data)).toEqual(['Fresh title'])
  })
})
