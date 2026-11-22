import { describe, expect, it } from 'vitest'
import { middleEllipsis } from './middle-ellipsis'

const upTo =
  (chars: number) =>
  (candidate: string): boolean =>
    candidate.length <= chars

describe('middleEllipsis', () => {
  it('keeps a label that fits', () => {
    expect(middleEllipsis('Local Mac', upTo(9))).toBe('Local Mac')
  })

  it('keeps an even start and end around the ellipsis', () => {
    expect(middleEllipsis('build-runner-02.eu-west.internal', upTo(15))).toBe('build-r…nternal')
    expect(middleEllipsis('build-runner-02.eu-west.internal', upTo(16))).toBe('build-r…internal')
  })

  it('never splits an emoji or an accented letter', () => {
    const graphemes = (text: string): number =>
      Array.from(new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)).length
    const upTo = (count: number) => (candidate: string) => graphemes(candidate) <= count
    const coder = '\u{1F469}\u{1F3FD}\u200D\u{1F4BB}'
    expect(middleEllipsis(coder.repeat(4), upTo(3))).toBe(`${coder}…${coder}`)
    expect(middleEllipsis('cafe\u0301-cafe\u0301', upTo(5))).toBe('ca…fe\u0301')
    expect(middleEllipsis('cafe\u0301-cafe\u0301', upTo(6))).toBe('ca…afe\u0301')
  })

  it('falls back to the ellipsis alone when nothing else fits', () => {
    expect(middleEllipsis('build-runner', upTo(1))).toBe('…')
  })
})
