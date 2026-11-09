import { describe, expect, it } from 'vitest'

import {
  configureLazyArabicShapingJoiner,
  ensureArabicShapingJoinerForText,
  findRtlJoinRanges
} from './terminal-arabic-shaping-joiner'

describe('findRtlJoinRanges', () => {
  it('produces separate ranges for RTL runs split by LTR text', () => {
    const text = 'اهلا and שלום'
    expect(findRtlJoinRanges(text)).toEqual([
      [0, 4],
      [9, 13]
    ])
  })

  it('does not open a run at orphan combining marks after an LTR base', () => {
    // Combining marks share their base cell; starting a run there yields an empty joined range that blanks the next WebGL glyph.
    expect(findRtlJoinRanges('a\u064b\u0651b')).toEqual([])
    expect(findRtlJoinRanges('x\u05b0\u05b1y')).toEqual([])
  })

  it('does not open a run at zero-width Cf controls after an LTR base', () => {
    // BOM/ZWNBSP and Arabic number signs have width zero; opening there also creates an empty joined range that blanks the next glyph.
    const BOM = '\ufeff'
    expect(findRtlJoinRanges(`a${BOM}${BOM}b`)).toEqual([])
    expect(findRtlJoinRanges('x\u0600\u0602y')).toEqual([])
    expect(findRtlJoinRanges(`a${BOM}\u0651b`)).toEqual([])
  })
})

describe('configureLazyArabicShapingJoiner', () => {
  function createLazyHost() {
    const events: string[] = []
    let handler: ((text: string) => [number, number][]) | null = null
    const terminal = {
      registerCharacterJoiner(nextHandler: (text: string) => [number, number][]): number {
        events.push('register')
        handler = nextHandler
        return 11
      },
      deregisterCharacterJoiner(joinerId: number): void {
        events.push(`deregister:${joinerId}`)
      }
    }
    return { events, terminal, getHandler: () => handler }
  }

  it('registers when a Bengali spacing vowel sign arrives in the next write', () => {
    const host = createLazyHost()
    configureLazyArabicShapingJoiner(host.terminal, () => true)

    ensureArabicShapingJoinerForText(host.terminal, 'ক')
    expect(host.events).toEqual([])
    ensureArabicShapingJoinerForText(host.terminal, 'ি')

    expect(host.events).toEqual(['register'])
  })

  it('recognizes a supplementary-plane RTL code point split across writes', () => {
    const host = createLazyHost()
    configureLazyArabicShapingJoiner(host.terminal, () => true)
    const adlam = String.fromCodePoint(0x1e900)

    ensureArabicShapingJoinerForText(host.terminal, adlam.charAt(0))
    expect(host.events).toEqual([])
    ensureArabicShapingJoinerForText(host.terminal, adlam.charAt(1))

    expect(host.events).toEqual(['register'])
  })
})
