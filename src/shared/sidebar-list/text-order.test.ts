import { describe, expect, it } from 'vitest'
import { compareCodePoints, compareSidebarText, createSidebarTextComparator } from './text-order'

// Built from code points so the formatter cannot fold the escapes into look-alike literals.
const COMBINING_ACUTE = String.fromCodePoint(0x301)
const REPLACEMENT_CHAR = String.fromCodePoint(0xfffd)

function sorted(values: readonly string[]): string[] {
  return [...values].sort(compareSidebarText)
}

describe('compareSidebarText', () => {
  it('orders digit runs by value', () => {
    expect(sorted(['w10', 'w2', 'w1', 'w100'])).toEqual(['w1', 'w2', 'w10', 'w100'])
    expect(compareSidebarText('task-9', 'task-10')).toBeLessThan(0)
    expect(compareSidebarText('v2.10', 'v2.9')).toBeGreaterThan(0)
  })

  it('compares digit runs longer than a safe integer without precision loss', () => {
    expect(compareSidebarText('id-90071992547409930', 'id-90071992547409931')).toBeLessThan(0)
  })

  it('folds case, then breaks the fold tie the same way everywhere', () => {
    expect(compareSidebarText('alpha', 'Beta')).toBeLessThan(0)
    expect(compareSidebarText('Alpha', 'beta')).toBeLessThan(0)
    expect(sorted(['alpha', 'ALPHA', 'Alpha'])).toEqual(['ALPHA', 'Alpha', 'alpha'])
  })

  it('treats leading zeros as equal in value, then orders them deterministically', () => {
    expect(sorted(['w2', 'w02', 'w3'])).toEqual(['w02', 'w2', 'w3'])
  })

  it('ignores accents, then lets them break an exact tie', () => {
    expect(sorted(['éclair', 'zebra', 'eclair'])).toEqual(['eclair', 'éclair', 'zebra'])
    expect(sorted(['zebra', 'Éclair', 'ecluse', 'eclair'])).toEqual([
      'eclair',
      'Éclair',
      'ecluse',
      'zebra'
    ])
    expect(compareSidebarText('Éclair', 'éclair')).toBeLessThan(0)
    expect(compareSidebarText('ångström', 'angstrom')).toBeGreaterThan(0)
    expect(compareSidebarText('ångström', 'b')).toBeLessThan(0)
  })

  it('treats NFC and NFD spellings as the same text', () => {
    const nfc = 'caf\u00e9'.normalize('NFC')
    const nfd = `cafe${COMBINING_ACUTE}`
    expect(nfc).not.toBe(nfd)
    expect(compareSidebarText(nfc, nfd)).toBe(0)
    expect(compareSidebarText(`CAFE${COMBINING_ACUTE}`, nfc)).toBeLessThan(0)
  })

  it('returns 0 only for canonically equal text, leaving the tie to the caller', () => {
    expect(compareSidebarText('same', 'same')).toBe(0)
    expect(compareSidebarText('', '')).toBe(0)
    expect(compareSidebarText('', 'a')).toBeLessThan(0)
    expect(compareSidebarText('a', 'a ')).toBeLessThan(0)
  })

  it('is antisymmetric across a mixed corpus', () => {
    const corpus = [
      'w2',
      'W10',
      'w02',
      'éclair',
      `e${COMBINING_ACUTE}clair`,
      'Zeta',
      '🎉 party',
      '日本',
      '',
      'a1b'
    ]
    for (const a of corpus) {
      for (const b of corpus) {
        expect(Math.sign(compareSidebarText(a, b)) + Math.sign(compareSidebarText(b, a))).toBe(0)
      }
    }
  })
})

describe('compareCodePoints', () => {
  it('orders astral characters by code point, not UTF-16 unit', () => {
    // U+1F389 is above U+FFFD, though its high surrogate (0xD83C) is below it.
    expect('🎉'.charCodeAt(0)).toBeLessThan(REPLACEMENT_CHAR.charCodeAt(0))
    expect(compareCodePoints('🎉', REPLACEMENT_CHAR)).toBeGreaterThan(0)
  })

  it('orders a prefix first', () => {
    expect(compareCodePoints('local|a', 'local|ab')).toBeLessThan(0)
    expect(compareCodePoints('x', 'x')).toBe(0)
  })
})

describe('createSidebarTextComparator', () => {
  it('orders exactly like compareSidebarText', () => {
    const corpus = ['w2', 'W10', 'w02', 'Éclair', 'éclair', 'zeta', 'ALPHA', 'alpha', '', 'a1b']
    const compare = createSidebarTextComparator()
    for (const a of corpus) {
      for (const b of corpus) {
        expect(Math.sign(compare(a, b))).toBe(Math.sign(compareSidebarText(a, b)))
      }
    }
  })
})
