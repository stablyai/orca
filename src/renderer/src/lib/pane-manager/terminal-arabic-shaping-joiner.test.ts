import { describe, expect, it } from 'vitest'

import {
  findRtlJoinRanges,
  isStrongRtlCodePoint,
  registerArabicShapingJoiner
} from './terminal-arabic-shaping-joiner'

describe('isStrongRtlCodePoint', () => {
  it('classifies Arabic and Hebrew letters as strong RTL', () => {
    expect(isStrongRtlCodePoint('م'.codePointAt(0)!)).toBe(true)
    expect(isStrongRtlCodePoint('ش'.codePointAt(0)!)).toBe(true)
    expect(isStrongRtlCodePoint('א'.codePointAt(0)!)).toBe(true)
    // Arabic presentation forms (legacy shaped codepoints).
    expect(isStrongRtlCodePoint(0xfe8d)).toBe(true)
    // Adlam (supplementary plane).
    expect(isStrongRtlCodePoint(0x1e900)).toBe(true)
  })

  it('does not classify Latin, box drawing, CJK, or emoji as RTL', () => {
    expect(isStrongRtlCodePoint('a'.codePointAt(0)!)).toBe(false)
    expect(isStrongRtlCodePoint('│'.codePointAt(0)!)).toBe(false)
    expect(isStrongRtlCodePoint('漢'.codePointAt(0)!)).toBe(false)
    expect(isStrongRtlCodePoint(0x1f600)).toBe(false)
  })
})

describe('findRtlJoinRanges', () => {
  it('returns no ranges for plain ASCII text', () => {
    expect(findRtlJoinRanges('ls -la | grep foo && echo done')).toEqual([])
  })

  it('returns no ranges for Latin-1/Cyrillic/Greek text below the RTL floor', () => {
    expect(findRtlJoinRanges('café привет αβγ')).toEqual([])
  })

  it('returns a fresh array on every call so xterm can merge into it safely', () => {
    const first = findRtlJoinRanges('plain')
    const second = findRtlJoinRanges('plain')
    expect(first).not.toBe(second)
  })

  it('joins a single Arabic word as one range', () => {
    const text = 'مرحبا'
    expect(findRtlJoinRanges(text)).toEqual([[0, text.length]])
  })

  it('joins a multi-word Arabic phrase across spaces as one range', () => {
    const text = 'مرحباً هذه مشكلة في اللغة العربية'
    expect(findRtlJoinRanges(text)).toEqual([[0, text.length]])
  })

  it('excludes leading and trailing neutrals from the range', () => {
    const text = '  مرحبا هذه  '
    expect(findRtlJoinRanges(text)).toEqual([[2, 11]])
  })

  it('stops the run at strong LTR words', () => {
    const text = 'مرحبا hello'
    expect(findRtlJoinRanges(text)).toEqual([[0, 5]])
  })

  it('does not pull an adjacent filename into the run', () => {
    const text = 'ملف test.txt'
    expect(findRtlJoinRanges(text)).toEqual([[0, 3]])
  })

  it('treats box-drawing characters as run breakers so TUI borders stay per-cell', () => {
    const text = '│ مرحبا بكم │'
    expect(findRtlJoinRanges(text)).toEqual([[2, 11]])
  })

  it('produces separate ranges for RTL runs split by LTR text', () => {
    const text = 'اهلا and שלום'
    expect(findRtlJoinRanges(text)).toEqual([
      [0, 4],
      [9, 13]
    ])
  })

  it('skips an isolated single RTL letter (already correct in isolated form)', () => {
    expect(findRtlJoinRanges('a م b')).toEqual([])
  })

  it('joins a letter with its combining tashkeel marks', () => {
    const text = 'مَ'
    expect(findRtlJoinRanges(text)).toEqual([[0, 2]])
  })

  it('tunnels through ASCII digits between Arabic words', () => {
    const text = 'صفحة 15 من 20 صفحة'
    expect(findRtlJoinRanges(text)).toEqual([[0, text.length]])
  })

  it('does not extend a run through trailing digits without a following RTL char', () => {
    const text = 'صفحة 15'
    expect(findRtlJoinRanges(text)).toEqual([[0, 4]])
  })

  it('joins Arabic-Indic digits and Arabic punctuation as part of the run', () => {
    const text = 'رقم ١٢٣، حسناً؟'
    expect(findRtlJoinRanges(text)).toEqual([[0, text.length]])
  })

  it('handles supplementary-plane RTL (Adlam) via surrogate pairs', () => {
    const text = '𞤀𞤣𞤤𞤢𞤥'
    expect(findRtlJoinRanges(text)).toEqual([[0, text.length]])
  })

  it('breaks runs on CJK and emoji above the scan floor', () => {
    const text = 'مرحبا漢بكم'
    expect(findRtlJoinRanges(text)).toEqual([
      [0, 5],
      [6, 9]
    ])
  })

  it('joins Hebrew words with niqqud points', () => {
    const text = 'שָׁלוֹם עוֹלָם'
    expect(findRtlJoinRanges(text)).toEqual([[0, text.length]])
  })

  // Escapes, not literals: these controls are invisible in source.
  const ZWNJ = '\u200c'
  const ZWJ = '\u200d'
  const RLM = '\u200f'
  const LRM = '\u200e'

  it('tunnels through ZWNJ inside a Persian word without splitting the run', () => {
    // می‌خواهم — splitting at the ZWNJ would render the word halves in
    // swapped visual order.
    const text = `می${ZWNJ}خواهم`
    expect(findRtlJoinRanges(text)).toEqual([[0, text.length]])
  })

  it('tunnels through ZWJ and RLM inside an RTL run', () => {
    const zwjText = `مر${ZWJ}حب`
    expect(findRtlJoinRanges(zwjText)).toEqual([[0, zwjText.length]])
    const rlmText = `سلام${RLM}عليكم`
    expect(findRtlJoinRanges(rlmText)).toEqual([[0, rlmText.length]])
  })

  it('excludes a trailing ZWNJ from the joined range', () => {
    expect(findRtlJoinRanges(`مرحبا${ZWNJ}`)).toEqual([[0, 5]])
  })

  it('does not let ZWNJ start a run or bridge into LTR text', () => {
    expect(findRtlJoinRanges(`${ZWNJ}abc`)).toEqual([])
    expect(findRtlJoinRanges(`مرحبا${ZWNJ}abc`)).toEqual([[0, 5]])
  })

  it('still breaks the run on LRM (strong LTR)', () => {
    expect(findRtlJoinRanges(`مرحبا${LRM}بكم`)).toEqual([
      [0, 5],
      [6, 9]
    ])
  })

  it('treats ALM as transparent like RLM', () => {
    const ALM = '\u061c'
    expect(findRtlJoinRanges(`${ALM}${ALM}`)).toEqual([])
    // An isolated letter stays isolated even with a leading direction mark.
    expect(findRtlJoinRanges(`${ALM}م`)).toEqual([])
    expect(findRtlJoinRanges(`مرحبا${ALM}`)).toEqual([[0, 5]])
    const text = `مرحبا${ALM}بكم`
    expect(findRtlJoinRanges(text)).toEqual([[0, text.length]])
  })

  it('does not open a run at orphan combining marks after an LTR base', () => {
    // Marks render inside their base's cell; a run opened mid-cell maps to an
    // empty joined cell range that blanks the following glyph in WebGL.
    expect(findRtlJoinRanges('a\u064b\u0651b')).toEqual([])
    expect(findRtlJoinRanges('x\u05b0\u05b1y')).toEqual([])
  })

  it('lets combining marks extend a run opened by a spacing RTL letter', () => {
    const text = 'منَّ هنا'
    expect(findRtlJoinRanges(text)).toEqual([[0, text.length]])
  })

  it('does not open a run at zero-width Cf controls after an LTR base', () => {
    // BOM/ZWNBSP and Arabic number signs are width-0 in xterm, so like
    // combining marks a run opened there maps to an empty joined cell range
    // that blanks the following glyph in WebGL.
    const BOM = '\ufeff'
    expect(findRtlJoinRanges(`a${BOM}${BOM}b`)).toEqual([])
    expect(findRtlJoinRanges('x\u0600\u0602y')).toEqual([])
    expect(findRtlJoinRanges(`a${BOM}\u0651b`)).toEqual([])
  })

  it('keeps zero-width Cf controls from opening or counting an RTL run', () => {
    const BOM = '\ufeff'
    // A single letter behind a BOM stays isolated (BOM neither opens nor counts).
    expect(findRtlJoinRanges(`${BOM}م`)).toEqual([])
    // BOM inside a word does not break the run.
    const text = `مرحبا${BOM}بكم`
    expect(findRtlJoinRanges(text)).toEqual([[0, text.length]])
  })
})

describe('registerArabicShapingJoiner', () => {
  function createJoinerHost(): {
    terminal: Parameters<typeof registerArabicShapingJoiner>[0]
    getRegistered: () => ((text: string) => [number, number][]) | null
    getDeregistered: () => number | null
  } {
    let registered: ((text: string) => [number, number][]) | null = null
    let deregistered: number | null = null
    return {
      terminal: {
        registerCharacterJoiner(handler: (text: string) => [number, number][]): number {
          registered = handler
          return 7
        },
        deregisterCharacterJoiner(joinerId: number): void {
          deregistered = joinerId
        }
      },
      getRegistered: () => registered,
      getDeregistered: () => deregistered
    }
  }

  it('registers a joining handler and returns a cleanup that deregisters it', () => {
    const host = createJoinerHost()
    const cleanup = registerArabicShapingJoiner(host.terminal, () => true)
    const text = 'مرحبا'
    expect(host.getRegistered()!(text)).toEqual([[0, text.length]])
    expect(host.getDeregistered()).toBeNull()

    // terminal.dispose() does not deregister joiners, so cleanup must.
    cleanup()
    expect(host.getDeregistered()).toBe(7)
  })

  it('returns no ranges while shaping is inactive (DOM renderer misrenders joined spans)', () => {
    const host = createJoinerHost()
    let webglLive = false
    registerArabicShapingJoiner(host.terminal, () => webglLive)
    const handler = host.getRegistered()!

    const inactive = handler('مرحبا')
    expect(inactive).toEqual([])
    // Fresh array each call — xterm mutates the handler's result in place.
    expect(handler('مرحبا')).not.toBe(inactive)

    webglLive = true
    expect(handler('مرحبا')).toEqual([[0, 5]])
  })
})
