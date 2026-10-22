import { describe, expect, it } from 'vitest'
import { classifyPaletteTranscriptProof } from './palette-transcript-proof'

const qualifies = (text: string, query: string): boolean =>
  classifyPaletteTranscriptProof(text, query).length > 0

describe('literal original transcript proof', () => {
  it('refuses malformed source evidence at the renderer boundary', () => {
    for (const text of [null, undefined, 17, { text: 'a refresh here' }, '\uD800refresh']) {
      expect(classifyPaletteTranscriptProof(text, 'refresh')).toEqual([])
    }
  })
  it.each([
    ['we fixed token refresh race here', 'token refresh race'],
    ['Browser annotation (v1.4.217)', '217'],
    ['call tokenRefresh and race_condition here', 'token refresh race'],
    ['look at [[refresh race]] … here', '"refresh race"'],
    ['we fixed REFRESH\n\t  race here', '"refresh race"'],
    ['a cafe\u0301 refresh here', 'café refresh'],
    ['😀 a café token here 🦀', 'café token'],
    ['a 𐐨𐐩 token here', '𐐨𐐩 token'],
    ['a 😀refresh here', 'refresh'],
    ['a cafe\u0301Refresh here', 'refresh'],
    ['a token refresh race here', 'repo:orca path:src token refresh race']
  ])('accepts interior whole tokens/phrases: %s / %s', (text, query) => {
    expect(qualifies(text, query)).toBe(true)
  })
  it.each([
    ['a car started here', 'car art'],
    ['Browser annotation (v1.4.2170)', '217'],
    ['a refresh here', 'token refresh race'],
    ['a token_refresh unrelated words race_condition here', '"refresh race"'],
    ['a refresh, race here', '"refresh race"'],
    ['a race refresh here', '"refresh race"'],
    ['a refresher here', 'refresh'],
    ['a token-refresh here', 'token-'],
    ['a foo[[refresh]] here', '[[refresh]]'],
    ['a refresh here', 'refersh'],
    ['a refresh here', 'repo:refresh'],
    ['refresh race here', 'refresh race'],
    ['a refresh race', 'refresh race'],
    ['a İ here', 'i'],
    ['a a\u035c here', 'a'],
    ['\u0301refresh here', 'refresh'],
    ['a x\u035crefresh here', 'refresh'],
    ['a 𐐨refresh here', 'refresh'],
    ['a refresh𐐨 here', 'refresh'],
    ['a refresh race here', '"refresh race"missing'],
    ['a refresh race here', 'refresh race the']
  ])('rejects incomplete, synthetic, or uncertain proof: %s / %s', (text, query) => {
    expect(qualifies(text, query)).toBe(false)
  })
  it('requires every original token beyond retrieval caps', () => {
    const words = Array.from({ length: 40 }, (_, index) => `word${index}`)
    expect(qualifies(`a ${words.join(' ')} here`, words.join(' '))).toBe(true)
    expect(qualifies(`a ${words.slice(0, -1).join(' ')} here`, words.join(' '))).toBe(false)
  })
  it('chooses compact repeated anchors and keeps UTF-16 source ranges', () => {
    const source = '😀 token unrelated words then tokenRefresh race here'
    const windows = classifyPaletteTranscriptProof(source, 'token refresh race')
    const minimal = windows[1]
    expect(minimal.text).toBe('tokenRefresh race')
    expect(minimal.sourceRanges.map((range) => source.slice(range.start, range.end))).toEqual([
      'tokenRefresh',
      'race'
    ])
    expect(minimal.ranges.map((range) => minimal.text.slice(range.start, range.end))).toEqual([
      'tokenRefresh',
      'race'
    ])
    expect(windows.length).toBeLessThanOrEqual(8)
  })
  it('maps NFC highlights back to complete source graphemes', () => {
    const source = '😀 a cafe\u0301 here'
    const window = classifyPaletteTranscriptProof(source, 'café')[1]
    expect(window.text).toBe('cafe\u0301')
    expect(window.ranges).toEqual([{ start: 0, end: 5 }])
    expect(window.sourceRanges).toEqual([{ start: 5, end: 10 }])
  })
})

it('accepts only explicitly supported message edges and keeps missing peer metadata conservative', () => {
  expect(classifyPaletteTranscriptProof('refresh', 'refresh')).toEqual([])
  expect(classifyPaletteTranscriptProof('refresh', 'refresh', { startsMessage: true })).toEqual([])
  expect(classifyPaletteTranscriptProof('refresh', 'refresh', { endsMessage: true })).toEqual([])
  expect(
    classifyPaletteTranscriptProof('refresh', 'refresh', {
      startsMessage: true,
      endsMessage: true
    })[1]?.ranges
  ).toEqual([{ start: 0, end: 7 }])
  expect(
    classifyPaletteTranscriptProof('refresh here', 'refresh', { startsMessage: true }).length
  ).toBeGreaterThan(0)
  expect(
    classifyPaletteTranscriptProof('a refresh', 'refresh', { endsMessage: true }).length
  ).toBeGreaterThan(0)
})
