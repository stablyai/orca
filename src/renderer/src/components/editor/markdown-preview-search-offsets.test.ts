import { afterEach, describe, expect, it, vi } from 'vitest'
import { findTextMatchRanges } from './markdown-preview-search'

function referenceMatchRanges(text: string, query: string): { start: number; end: number }[] {
  let normalized = ''
  let originalOffset = 0
  const starts: number[] = []
  const ends: number[] = []
  for (const char of text) {
    const lowercase = char.toLocaleLowerCase()
    for (let index = 0; index < lowercase.length; index += 1) {
      starts.push(originalOffset)
      ends.push(originalOffset + char.length)
    }
    normalized += lowercase
    originalOffset += char.length
  }
  const normalizedQuery = Array.from(query, (char) => char.toLocaleLowerCase()).join('')
  const matches: { start: number; end: number }[] = []
  let searchStart = 0
  while (searchStart <= normalized.length - normalizedQuery.length) {
    const start = normalized.indexOf(normalizedQuery, searchStart)
    if (start === -1) {
      break
    }
    const end = start + normalizedQuery.length
    matches.push({ start: starts[start] ?? text.length, end: ends[end - 1] ?? text.length })
    searchStart = end + (normalizedQuery.length === 0 ? 1 : 0)
  }
  return matches
}

function createRandom(seed: number): (max: number) => number {
  let state = seed
  return (max) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state % max
  }
}

function mockLowercaseLocale(locale: string): void {
  const lowercase = String.prototype.toLocaleLowerCase
  vi.spyOn(String.prototype, 'toLocaleLowerCase').mockImplementation(function (this: string) {
    return lowercase.call(this, locale)
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('case-insensitive Markdown search offsets', () => {
  it('finds a match at the end of a large ordinary text node', () => {
    const prefix = 'a'.repeat(512 * 1024)
    expect(findTextMatchRanges(`${prefix} Needle`, 'needle')).toEqual([
      { start: prefix.length + 1, end: prefix.length + 7 }
    ])
  })

  it.each(['İ', '😊', '𐐀'])('keeps offsets across an ordinary prefix and %s', (character) => {
    const text = `Prefix ${character} NEEDLE ${character} needle`
    expect(findTextMatchRanges(text, 'needle')).toEqual(referenceMatchRanges(text, 'needle'))
  })

  it('preserves whole code-point ranges for lone surrogate queries', () => {
    const text = 'plain😊plain'
    expect(findTextMatchRanges(text, '\ud83d')).toEqual([{ start: 5, end: 7 }])
    expect(findTextMatchRanges(text, '\ude0a')).toEqual([{ start: 5, end: 7 }])
  })

  it('keeps character-wise Greek sigma casing in a Unicode document', () => {
    expect(findTextMatchRanges('AΣ Aς Aσ', 'aσ')).toEqual([
      { start: 0, end: 2 },
      { start: 6, end: 8 }
    ])
  })

  it.each(['en-US', 'tr', 'az', 'lt', 'el'])(
    'preserves every ASCII character in locale %s',
    (locale) => {
      mockLowercaseLocale(locale)
      const ascii = Array.from({ length: 128 }, (_, index) => String.fromCharCode(index)).join('')
      const text = `${ascii} IJI iIj ${ascii}`
      for (const query of [...ascii, 'IJI', 'iij', 'j']) {
        expect(findTextMatchRanges(text, query)).toEqual(referenceMatchRanges(text, query))
      }
    }
  )

  it.each(['en-US', 'tr', 'az', 'lt', 'el'])(
    'matches reference code-point folding in locale %s',
    (locale) => {
      mockLowercaseLocale(locale)
      const random = createRandom(101)
      const characters = [
        'a',
        'B',
        ' ',
        'İ',
        'I',
        'ı',
        '\u0307',
        'Σ',
        'σ',
        'ς',
        '𐐀',
        '𐐨',
        '😊',
        '\ud800',
        '\udc00'
      ]
      for (let sample = 0; sample < 250; sample += 1) {
        let text = ''
        for (let index = 0; index < 100; index += 1) {
          text += characters[random(characters.length)]
        }
        const start = random(text.length)
        const query = text.slice(start, start + random(4) + 1)
        expect(findTextMatchRanges(text, query)).toEqual(referenceMatchRanges(text, query))
      }
    }
  )
})
