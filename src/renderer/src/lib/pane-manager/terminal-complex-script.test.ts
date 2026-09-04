import { describe, expect, it } from 'vitest'
import {
  nativeWindowsRewriteNeedsFollowupRenderRefresh,
  terminalOutputContainsEastAsianRendererRisk,
  terminalOutputPrefersRenderRefresh,
  terminalRewriteOutputRenderRefreshDecision,
  terminalRewriteOutputPrefersRenderRefresh,
  windowsEastAsianOutputPrefersRenderRefresh,
  type TerminalRewriteOutputRenderRefreshState
} from './terminal-complex-script'

describe('terminalOutputPrefersRenderRefresh', () => {
  it('detects Arabic terminal output', () => {
    expect(terminalOutputPrefersRenderRefresh('Arabic: السلام عليكم')).toBe(true)
  })

  it('detects RTL scripts that need browser text shaping/order', () => {
    expect(terminalOutputPrefersRenderRefresh('Hebrew: שלום')).toBe(true)
  })

  it('detects East Asian wide and fullwidth terminal output', () => {
    expect(
      terminalOutputPrefersRenderRefresh('直接接请求本地 /api/mcp，带同一个 Bearer token，成功')
    ).toBe(true)
    expect(terminalOutputPrefersRenderRefresh('Japanese: ターミナル')).toBe(true)
    expect(terminalOutputPrefersRenderRefresh('Korean: 터미널')).toBe(true)
    expect(terminalOutputPrefersRenderRefresh('Fullwidth: ＡＢＣ１２３')).toBe(true)
  })

  it('keeps terminal drawing glyphs on WebGL', () => {
    expect(terminalOutputPrefersRenderRefresh('⠋ Working')).toBe(false)
    expect(terminalOutputPrefersRenderRefresh('├─ file.ts')).toBe(false)
    expect(terminalOutputPrefersRenderRefresh('█ progress')).toBe(false)
    expect(terminalOutputPrefersRenderRefresh('◆ status')).toBe(false)
    expect(terminalOutputPrefersRenderRefresh('\uE0B0 prompt')).toBe(false)
  })

  it('detects malformed replacement characters', () => {
    expect(terminalOutputPrefersRenderRefresh('bad replacement �')).toBe(true)
  })

  it('detects emoji and variation sequences', () => {
    expect(terminalOutputPrefersRenderRefresh('status 🚀')).toBe(true)
    expect(terminalOutputPrefersRenderRefresh('developer 👩‍💻')).toBe(true)
    expect(terminalOutputPrefersRenderRefresh('heart ♥️')).toBe(true)
  })

  it('detects supplementary-plane complex-script ranges', () => {
    expect(terminalOutputPrefersRenderRefresh('Adlam: 𞤀')).toBe(true)
    expect(terminalOutputPrefersRenderRefresh('Medefaidrin: 𐻀')).toBe(true)
  })

  it('detects split surrogate chunks so refresh is not lost at chunk boundaries', () => {
    const [high, low] = Array.from('🚀')[0].split('')

    expect(terminalOutputPrefersRenderRefresh(high)).toBe(true)
    expect(terminalOutputPrefersRenderRefresh(low)).toBe(true)
  })

  it('detects ASCII ANSI background SGR output before the non-ASCII fast path', () => {
    expect(terminalOutputPrefersRenderRefresh('\x1b[48;2;12;34;56m codex input \x1b[0m')).toBe(true)
    expect(terminalOutputPrefersRenderRefresh('\x1b[48:2::12:34:56m codex input \x1b[0m')).toBe(
      true
    )
    expect(terminalOutputPrefersRenderRefresh('\x1b[44m selected block \x1b[0m')).toBe(true)
    expect(terminalOutputPrefersRenderRefresh('\x1b[104m bright selected block \x1b[0m')).toBe(true)
  })

  it('does not disable WebGL for ordinary terminal output or ANSI controls alone', () => {
    expect(terminalOutputPrefersRenderRefresh('abc 123 ✓')).toBe(false)
    expect(terminalOutputPrefersRenderRefresh('\x1b[32mplain green\x1b[0m')).toBe(false)
    expect(terminalOutputPrefersRenderRefresh('\x1b[38;2;48;34;56m foreground only\x1b[0m')).toBe(
      false
    )
    expect(terminalOutputPrefersRenderRefresh('\x1b[38:2::48:34:56m foreground only\x1b[0m')).toBe(
      false
    )
  })
})

describe('terminalOutputContainsEastAsianRendererRisk', () => {
  it('detects CJK, fullwidth, and Korean output', () => {
    expect(terminalOutputContainsEastAsianRendererRisk('已经安装完成，软件已更新后重启。')).toBe(
      true
    )
    expect(terminalOutputContainsEastAsianRendererRisk('Fullwidth: ＡＢＣ１２３')).toBe(true)
    expect(terminalOutputContainsEastAsianRendererRisk('Korean: 터미널')).toBe(true)
  })

  it('does not match non-East-Asian renderer-risk Unicode', () => {
    expect(terminalOutputContainsEastAsianRendererRisk('Arabic: السلام عليكم')).toBe(false)
    expect(terminalOutputContainsEastAsianRendererRisk('status 🚀')).toBe(false)
    expect(terminalOutputContainsEastAsianRendererRisk('developer 👩‍💻')).toBe(false)
  })
})

describe('windowsEastAsianOutputPrefersRenderRefresh', () => {
  const maxInteractiveRedrawChars = 128 * 1024

  it('refreshes native Windows ConPTY agent output with CJK or Korean glyphs', () => {
    expect(
      windowsEastAsianOutputPrefersRenderRefresh('已经安装完成，软件已更新后重启。', {
        isWindowsClient: true,
        isNativeWindowsConpty: true,
        hadRecentInput: false,
        maxInteractiveRedrawChars
      })
    ).toBe(true)
    expect(
      windowsEastAsianOutputPrefersRenderRefresh('Korean: 터미널', {
        isWindowsClient: true,
        isNativeWindowsConpty: true,
        hadRecentInput: false,
        maxInteractiveRedrawChars
      })
    ).toBe(true)
  })

  it('keeps the recent-input Windows renderer path for SSH and other non-native panes', () => {
    expect(
      windowsEastAsianOutputPrefersRenderRefresh('已经安装完成，软件已更新后重启。', {
        isWindowsClient: true,
        isNativeWindowsConpty: false,
        hadRecentInput: true,
        maxInteractiveRedrawChars
      })
    ).toBe(true)
  })

  it('skips remote agent output and non-Windows clients without recent input', () => {
    expect(
      windowsEastAsianOutputPrefersRenderRefresh('已经安装完成，软件已更新后重启。', {
        isWindowsClient: true,
        isNativeWindowsConpty: false,
        hadRecentInput: false,
        maxInteractiveRedrawChars
      })
    ).toBe(false)
    expect(
      windowsEastAsianOutputPrefersRenderRefresh('已经安装完成，软件已更新后重启。', {
        isWindowsClient: false,
        isNativeWindowsConpty: false,
        hadRecentInput: true,
        maxInteractiveRedrawChars
      })
    ).toBe(false)
  })

  it('does not refresh ASCII, non-East-Asian Unicode, or bulk chunks', () => {
    expect(
      windowsEastAsianOutputPrefersRenderRefresh('plain terminal output', {
        isWindowsClient: true,
        isNativeWindowsConpty: true,
        hadRecentInput: false,
        maxInteractiveRedrawChars
      })
    ).toBe(false)
    expect(
      windowsEastAsianOutputPrefersRenderRefresh('Arabic: السلام عليكم', {
        isWindowsClient: true,
        isNativeWindowsConpty: true,
        hadRecentInput: false,
        maxInteractiveRedrawChars
      })
    ).toBe(false)
    expect(
      windowsEastAsianOutputPrefersRenderRefresh('已'.repeat(maxInteractiveRedrawChars + 1), {
        isWindowsClient: true,
        isNativeWindowsConpty: true,
        hadRecentInput: false,
        maxInteractiveRedrawChars
      })
    ).toBe(false)
  })
})

describe('terminalRewriteOutputPrefersRenderRefresh', () => {
  it('detects in-place carriage-return redraws', () => {
    expect(terminalRewriteOutputPrefersRenderRefresh('\r• Working')).toBe(true)
    expect(terminalRewriteOutputPrefersRenderRefresh('prefix\r\x1b[2K• Working')).toBe(true)
  })

  it('does not treat normal CRLF output as an in-place redraw', () => {
    expect(terminalRewriteOutputPrefersRenderRefresh('line one\r\nline two\r\n')).toBe(false)
  })

  it('waits on a trailing carriage return so split CRLF output does not refresh early', () => {
    expect(terminalRewriteOutputPrefersRenderRefresh('line one\r')).toBe(false)
    expect(terminalRewriteOutputPrefersRenderRefresh('\nline two')).toBe(false)
  })

  it('detects terminal erase rewrites and backspace updates', () => {
    expect(terminalRewriteOutputPrefersRenderRefresh('\x1b[2K• Working')).toBe(true)
    expect(terminalRewriteOutputPrefersRenderRefresh('\x1b[2J\x1b[Hredraw')).toBe(true)
    expect(terminalRewriteOutputPrefersRenderRefresh('progress 10%\b\b20%')).toBe(true)
  })

  it('still detects split Codex-style rewrites through the erase-line chunk', () => {
    expect(terminalRewriteOutputPrefersRenderRefresh('\r')).toBe(false)
    expect(terminalRewriteOutputPrefersRenderRefresh('\x1b[2K• Working')).toBe(true)
  })

  it('ignores ordinary cursor movement and style output', () => {
    expect(terminalRewriteOutputPrefersRenderRefresh('\x1b[10;2Hcursor move')).toBe(false)
    expect(terminalRewriteOutputPrefersRenderRefresh('\x1b[32mplain green\x1b[0m')).toBe(false)
  })
})

describe('terminalRewriteOutputRenderRefreshDecision', () => {
  it('refreshes when a trailing carriage return continues as a split redraw', () => {
    const trailingCarriageReturn = terminalRewriteOutputRenderRefreshDecision('\r', {
      previousChunkEndsWithCarriageReturn: false,
      previousRewriteCsiScanTail: ''
    })
    expect(trailingCarriageReturn).toEqual({
      nextChunkEndsWithCarriageReturn: true,
      nextRewriteCsiScanTail: '',
      prefersRenderRefresh: false
    })

    expect(
      terminalRewriteOutputRenderRefreshDecision('• Working without erase-line', {
        previousChunkEndsWithCarriageReturn: true,
        previousRewriteCsiScanTail: ''
      })
    ).toEqual({
      nextChunkEndsWithCarriageReturn: false,
      nextRewriteCsiScanTail: '',
      prefersRenderRefresh: true
    })
  })

  it('does not refresh split CRLF output', () => {
    const trailingCarriageReturn = terminalRewriteOutputRenderRefreshDecision('line one\r', {
      previousChunkEndsWithCarriageReturn: false,
      previousRewriteCsiScanTail: ''
    })
    expect(trailingCarriageReturn).toEqual({
      nextChunkEndsWithCarriageReturn: true,
      nextRewriteCsiScanTail: '',
      prefersRenderRefresh: false
    })

    expect(
      terminalRewriteOutputRenderRefreshDecision('\nline two', {
        previousChunkEndsWithCarriageReturn: true,
        previousRewriteCsiScanTail: ''
      })
    ).toEqual({
      nextChunkEndsWithCarriageReturn: false,
      nextRewriteCsiScanTail: '',
      prefersRenderRefresh: false
    })
  })

  it('refreshes when a rewrite erase sequence is split across chunks', () => {
    const trailingRewriteCsi = terminalRewriteOutputRenderRefreshDecision('\r\x1b[', {
      previousChunkEndsWithCarriageReturn: false,
      previousRewriteCsiScanTail: ''
    })
    expect(trailingRewriteCsi).toEqual({
      nextChunkEndsWithCarriageReturn: false,
      nextRewriteCsiScanTail: '\x1b[',
      prefersRenderRefresh: true
    })

    expect(
      terminalRewriteOutputRenderRefreshDecision('2K• Working', {
        previousChunkEndsWithCarriageReturn: false,
        previousRewriteCsiScanTail: '\x1b['
      })
    ).toEqual({
      nextChunkEndsWithCarriageReturn: false,
      nextRewriteCsiScanTail: '',
      prefersRenderRefresh: true
    })
  })

  it('carries rewrite erase sequence tails split before CSI introducer or params', () => {
    expect(
      terminalRewriteOutputRenderRefreshDecision('\x1b', {
        previousChunkEndsWithCarriageReturn: false,
        previousRewriteCsiScanTail: ''
      })
    ).toEqual({
      nextChunkEndsWithCarriageReturn: false,
      nextRewriteCsiScanTail: '\x1b',
      prefersRenderRefresh: false
    })

    expect(
      terminalRewriteOutputRenderRefreshDecision('2J', {
        previousChunkEndsWithCarriageReturn: false,
        previousRewriteCsiScanTail: '\x1b['
      })
    ).toEqual({
      nextChunkEndsWithCarriageReturn: false,
      nextRewriteCsiScanTail: '',
      prefersRenderRefresh: true
    })
  })

  it('drops overlong rewrite CSI tails', () => {
    expect(
      terminalRewriteOutputRenderRefreshDecision(`\x1b[${'1'.repeat(80)}`, {
        previousChunkEndsWithCarriageReturn: false,
        previousRewriteCsiScanTail: ''
      })
    ).toEqual({
      nextChunkEndsWithCarriageReturn: false,
      nextRewriteCsiScanTail: '',
      prefersRenderRefresh: false
    })
  })

  it('preserves pending trailing carriage return state across empty chunks', () => {
    expect(
      terminalRewriteOutputRenderRefreshDecision('', {
        previousChunkEndsWithCarriageReturn: true,
        previousRewriteCsiScanTail: '\x1b['
      })
    ).toEqual({
      nextChunkEndsWithCarriageReturn: true,
      nextRewriteCsiScanTail: '\x1b[',
      prefersRenderRefresh: false
    })
  })
})

describe('nativeWindowsRewriteNeedsFollowupRenderRefresh', () => {
  // Why: Claude Code (issue #5656/#5653) echoes prompt keystrokes by redrawing
  // the input line in place with CR + CHA + reprint + erase-line, split across
  // ConPTY chunks, and WITHOUT DEC 2026 synchronized output. Replay that exact
  // pattern through the rewrite decision and assert that on native Windows it
  // requests a follow-up next-frame repaint, which is what stops the phantom /
  // overwritten characters without the user resizing the window.
  function rewriteIsInPlace(chunks: string[]): boolean[] {
    const state: TerminalRewriteOutputRenderRefreshState = {
      previousChunkEndsWithCarriageReturn: false,
      previousRewriteCsiScanTail: ''
    }
    return chunks.map((chunk) => {
      const decision = terminalRewriteOutputRenderRefreshDecision(chunk, state)
      state.previousChunkEndsWithCarriageReturn = decision.nextChunkEndsWithCarriageReturn
      state.previousRewriteCsiScanTail = decision.nextRewriteCsiScanTail
      return decision.prefersRenderRefresh
    })
  }

  it('schedules a follow-up repaint for the split Claude prompt redraw on native Windows', () => {
    // "> " prompt, then user types z, z, z, x — each keystroke redraws in place.
    const claudeRedrawChunks = [
      '\r\x1b[3G',
      'z\x1b[K',
      '\r\x1b[3G',
      'zz\x1b[K',
      '\r\x1b[3G',
      'zzz\x1b[K',
      '\r\x1b[3G',
      'zzzx\x1b[K'
    ]
    const inPlace = rewriteIsInPlace(claudeRedrawChunks)
    // Every redraw chunk is an in-place rewrite (CR continuation or erase-line).
    expect(inPlace.every(Boolean)).toBe(true)
    for (const isInPlaceRewrite of inPlace) {
      expect(
        nativeWindowsRewriteNeedsFollowupRenderRefresh({
          isNativeWindowsConpty: true,
          isForeground: true,
          isInPlaceRewrite
        })
      ).toBe(true)
    }
  })

  it('does not schedule a follow-up repaint for ordinary CRLF foreground output', () => {
    const inPlace = rewriteIsInPlace(['line one\r\n', 'line two\r\n'])
    expect(inPlace).toEqual([false, false])
    for (const isInPlaceRewrite of inPlace) {
      expect(
        nativeWindowsRewriteNeedsFollowupRenderRefresh({
          isNativeWindowsConpty: true,
          isForeground: true,
          isInPlaceRewrite
        })
      ).toBe(false)
    }
  })

  it('stays off for non-Windows renderers and background writes', () => {
    expect(
      nativeWindowsRewriteNeedsFollowupRenderRefresh({
        isNativeWindowsConpty: false,
        isForeground: true,
        isInPlaceRewrite: true
      })
    ).toBe(false)
    expect(
      nativeWindowsRewriteNeedsFollowupRenderRefresh({
        isNativeWindowsConpty: true,
        isForeground: false,
        isInPlaceRewrite: true
      })
    ).toBe(false)
  })
})

describe('terminalOutputPrefersRenderRefresh single-pass classification', () => {
  const EMOJI_PRESENTATION_PATTERN = /\p{Emoji_Presentation}/u

  function isInRange(value: number, start: number, end: number): boolean {
    return value >= start && value <= end
  }

  function isRendererRiskCodePoint(value: number): boolean {
    return (
      isInRange(value, 0x0590, 0x08ff) ||
      value === 0x200d ||
      isInRange(value, 0x1100, 0x11ff) ||
      isInRange(value, 0x2e80, 0x9fff) ||
      isInRange(value, 0xa960, 0xa97f) ||
      isInRange(value, 0xac00, 0xd7ff) ||
      isInRange(value, 0xd800, 0xdfff) ||
      isInRange(value, 0xf900, 0xfaff) ||
      isInRange(value, 0xfe10, 0xfe1f) ||
      isInRange(value, 0xfe30, 0xfe4f) ||
      isInRange(value, 0xfb1d, 0xfdff) ||
      isInRange(value, 0xfe00, 0xfe0f) ||
      isInRange(value, 0xfe70, 0xfeff) ||
      isInRange(value, 0xff00, 0xffef) ||
      value === 0xfffd ||
      isInRange(value, 0x10ec0, 0x10eff) ||
      isInRange(value, 0x1e900, 0x1e95f) ||
      isInRange(value, 0x20000, 0x2fa1f) ||
      isInRange(value, 0x30000, 0x3134f) ||
      isInRange(value, 0xe0100, 0xe01ef)
    )
  }

  function sgrParamCode(param: string | undefined): number | null {
    if (!param) {
      return null
    }
    const [head] = param.split(':')
    const value = Number.parseInt(head ?? '', 10)
    return Number.isFinite(value) ? value : null
  }

  function sgrSequenceSetsBackground(params: string): boolean {
    const parts = params.split(';')
    for (let i = 0; i < parts.length; i += 1) {
      const value = sgrParamCode(parts[i])
      if (value === null) {
        continue
      }
      if (isInRange(value, 40, 47) || isInRange(value, 100, 107)) {
        return true
      }
      if (value === 48) {
        return true
      }
      if (value === 38 && !parts[i]?.includes(':')) {
        const mode = sgrParamCode(parts[i + 1])
        if (mode === 5) {
          i += 2
        } else if (mode === 2) {
          i += 4
        } else {
          i += 1
        }
      }
    }
    return false
  }

  /** The pre-optimization multi-pass classifier, kept verbatim as the oracle. */
  function referencePrefersRenderRefresh(data: string): boolean {
    // eslint-disable-next-line no-control-regex -- terminal escape sequences contain control bytes
    const sgrPattern = /\x1b\[([0-9:;]*)m/g
    for (let match = sgrPattern.exec(data); match; match = sgrPattern.exec(data)) {
      if (sgrSequenceSetsBackground(match[1] ?? '')) {
        return true
      }
    }
    let hasNonAscii = false
    for (let i = 0; i < data.length; i += 1) {
      if (data.charCodeAt(i) > 0x7f) {
        hasNonAscii = true
        break
      }
    }
    if (!hasNonAscii) {
      return false
    }
    if (EMOJI_PRESENTATION_PATTERN.test(data)) {
      return true
    }
    for (let i = 0; i < data.length; i += 1) {
      const codePoint = data.codePointAt(i)
      if (codePoint === undefined) {
        continue
      }
      if (isRendererRiskCodePoint(codePoint)) {
        return true
      }
      if (codePoint > 0xffff) {
        i += 1
      }
    }
    return false
  }

  const corpus = [
    '',
    'plain ascii log line',
    'npm run build \x1b[32mdone\x1b[0m',
    '\x1b[1;38;5;214mwarn\x1b[0m ready',
    '\x1b[41mred background\x1b[49m',
    '\x1b[48;5;238m dim \x1b[0m',
    '\x1b[48;2;12;34;56m truecolor \x1b[0m',
    '\x1b[100mbright background\x1b[0m',
    '\x1b[38;5;3;44mfg then bg\x1b[0m',
    '\x1b[38;2;1;2;3;41mfg truecolor then bg\x1b[0m',
    '\x1b[38:5:9mcolon fg\x1b[0m',
    // 38;2 consumes four parameters, so this 44 is the blue component, not a background.
    '\x1b[38;2;1;2;44m',
    // The colon form does not consume trailing parameters, so this 44 is a background.
    '\x1b[38:5:1;44m',
    '\x1b[38:2::1:2:3;44m',
    '\x1b[m',
    '\x1b[;m',
    '\x1b[38m',
    '\x1b[38;m',
    '\x1b[38;5m',
    '\x1b[39;49m',
    '\x1b[\x1b[41m',
    '\x1b[41',
    '\x1b[<0;1;2M',
    '\x1b[2K\x1b[1;1H',
    'spinner \x1b[?25l',
    'box drawing \u251c\u2500',
    'braille spinner \u283b',
    'block \u2588',
    'powerline \ue0b0',
    'emoji rocket \u{1f680}',
    'emoji zwj \u{1f469}\u200d\u{1f4bb}',
    'variation \u2665\ufe0f',
    'cjk \u76f4\u63a5',
    'hangul \ud130',
    'hebrew \u05e9',
    'arabic \u0627',
    'replacement \ufffd',
    'lone surrogate \ud83d',
    'astral tail \u{2f81a}',
    // An astral code point outside every risk range must advance past both halves.
    'math bold \u{1d400} x',
    '\x1b[41m\u{1f680}',
    '\u{1f680}\x1b[41m'
  ]

  it('classifies the full corpus exactly as the multi-pass version did', () => {
    for (const sample of corpus) {
      expect([sample, terminalOutputPrefersRenderRefresh(sample)]).toEqual([
        sample,
        referencePrefersRenderRefresh(sample)
      ])
    }
  })

  it('classifies randomly assembled agent-like chunks the same way', () => {
    let seed = 0x51f3a7d
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    for (let iteration = 0; iteration < 600; iteration++) {
      let sample = ''
      const pieces = 1 + Math.floor(random() * 6)
      for (let piece = 0; piece < pieces; piece++) {
        sample += corpus[Math.floor(random() * corpus.length)] ?? ''
      }
      expect([sample, terminalOutputPrefersRenderRefresh(sample)]).toEqual([
        sample,
        referencePrefersRenderRefresh(sample)
      ])
    }
  })

  it('classifies random SGR parameter runs the same way', () => {
    const parameterAlphabet = '0123456789;:'
    let seed = 0x7c1de91
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    for (let iteration = 0; iteration < 4000; iteration++) {
      let params = ''
      const length = Math.floor(random() * 12)
      for (let index = 0; index < length; index++) {
        params += parameterAlphabet[Math.floor(random() * parameterAlphabet.length)]
      }
      const sample = `\x1b[${params}m`
      expect([sample, terminalOutputPrefersRenderRefresh(sample)]).toEqual([
        sample,
        referencePrefersRenderRefresh(sample)
      ])
    }
  })
})
