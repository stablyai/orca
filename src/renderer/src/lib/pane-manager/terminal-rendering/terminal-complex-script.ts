// Detect foreground ANSI chunks whose background fills precede glyphs so targeted refresh repairs them without selecting renderers by content.
const EMOJI_PRESENTATION_PATTERN = /\p{Emoji_Presentation}/u
const ESCAPE_CHARACTER = String.fromCharCode(0x1b)
const REWRITE_CSI_SCAN_TAIL_MAX_CHARS = 64

function containsStandaloneCarriageReturn(data: string): boolean {
  let index = data.indexOf('\r')
  while (index !== -1) {
    if (index === data.length - 1) {
      return false
    }
    if (data[index + 1] !== '\n') {
      return true
    }
    index = data.indexOf('\r', index + 1)
  }
  return false
}

function isInRange(value: number, start: number, end: number): boolean {
  return value >= start && value <= end
}

function isRendererRiskCodePoint(value: number): boolean {
  return (
    isInRange(value, 0x0590, 0x08ff) ||
    value === 0x200d ||
    isInRange(value, 0x1100, 0x11ff) ||
    // Share refresh classification without making Unicode output a renderer-selection signal.
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

function isEastAsianRendererRiskCodePoint(value: number): boolean {
  return (
    isInRange(value, 0x1100, 0x11ff) ||
    isInRange(value, 0x2e80, 0x9fff) ||
    isInRange(value, 0xa960, 0xa97f) ||
    isInRange(value, 0xac00, 0xd7ff) ||
    isInRange(value, 0xf900, 0xfaff) ||
    isInRange(value, 0xfe10, 0xfe1f) ||
    isInRange(value, 0xfe30, 0xfe4f) ||
    isInRange(value, 0xff00, 0xffef) ||
    isInRange(value, 0x20000, 0x2fa1f) ||
    isInRange(value, 0x30000, 0x3134f)
  )
}

const SEMICOLON = 0x3b
const COLON = 0x3a
const DIGIT_ZERO = 0x30
const DIGIT_NINE = 0x39
const SGR_FINAL = 0x6d

/** Leading decimal of one SGR parameter (digits before any ':'); null when that head is empty. */
function sgrParamCodeAt(data: string, start: number, end: number): number | null {
  let value = 0
  let index = start
  for (; index < end; index++) {
    const code = data.charCodeAt(index)
    if (code === COLON) {
      break
    }
    // Saturate: only codes up to 107 matter, and a huge code must not wrap into that range.
    value = value > 1000 ? value : value * 10 + (code - DIGIT_ZERO)
  }
  return index === start ? null : value
}

function sgrParamEnd(data: string, start: number, paramsEnd: number): number {
  for (let index = start; index < paramsEnd; index++) {
    if (data.charCodeAt(index) === SEMICOLON) {
      return index
    }
  }
  return paramsEnd
}

function sgrParamHasColon(data: string, start: number, end: number): boolean {
  for (let index = start; index < end; index++) {
    if (data.charCodeAt(index) === COLON) {
      return true
    }
  }
  return false
}

// Walks `params` in place; allocating per SGR made this scan cost as much as xterm's own parse on coloured floods.
function sgrSequenceSetsBackground(data: string, paramsStart: number, paramsEnd: number): boolean {
  let skipParams = 0
  for (let start = paramsStart; start <= paramsEnd;) {
    const end = sgrParamEnd(data, start, paramsEnd)
    const next = end + 1
    if (skipParams > 0) {
      skipParams -= 1
      start = next
      continue
    }
    const value = sgrParamCodeAt(data, start, end)
    if (value !== null) {
      if (isInRange(value, 40, 47) || isInRange(value, 100, 107) || value === 48) {
        return true
      }
      if (value === 38 && !sgrParamHasColon(data, start, end)) {
        const mode =
          next <= paramsEnd ? sgrParamCodeAt(data, next, sgrParamEnd(data, next, paramsEnd)) : null
        skipParams = mode === 5 ? 2 : mode === 2 ? 4 : 1
      }
    }
    start = next
  }
  return false
}

function isSgrParamCode(code: number): boolean {
  return (code >= DIGIT_ZERO && code <= DIGIT_NINE) || code === SEMICOLON || code === COLON
}

function containsBackgroundSgr(data: string): boolean {
  let escapeIndex = data.indexOf('\x1b[')
  while (escapeIndex !== -1) {
    const paramsStart = escapeIndex + 2
    let paramsEnd = paramsStart
    while (paramsEnd < data.length && isSgrParamCode(data.charCodeAt(paramsEnd))) {
      paramsEnd += 1
    }
    if (
      paramsEnd < data.length &&
      data.charCodeAt(paramsEnd) === SGR_FINAL &&
      sgrSequenceSetsBackground(data, paramsStart, paramsEnd)
    ) {
      return true
    }
    escapeIndex = data.indexOf('\x1b[', paramsEnd)
  }
  return false
}

function containsRewriteEraseSequence(data: string): boolean {
  let escapeIndex = data.indexOf('\x1b[')
  while (escapeIndex !== -1) {
    for (let index = escapeIndex + 2; index < data.length; index++) {
      const char = data[index]
      if (char >= '0' && char <= '9') {
        continue
      }
      if (char === ';' || char === '?') {
        continue
      }
      // Erase rewrites can leave stale visible cells despite correct xterm buffers; repaint without requiring resize.
      if (char === 'J' || char === 'K') {
        return true
      }
      break
    }
    escapeIndex = data.indexOf('\x1b[', escapeIndex + 2)
  }
  return false
}

function trailingIncompleteRewriteCsiTail(data: string): string {
  const escapeIndex = data.lastIndexOf(ESCAPE_CHARACTER)
  if (escapeIndex === -1) {
    return ''
  }
  const tail = data.slice(escapeIndex)
  if (tail === ESCAPE_CHARACTER) {
    return tail
  }
  if (!tail.startsWith('\x1b[')) {
    return ''
  }
  if (tail.length > REWRITE_CSI_SCAN_TAIL_MAX_CHARS) {
    return ''
  }
  for (let index = 2; index < tail.length; index++) {
    const char = tail[index]
    if (char >= '0' && char <= '9') {
      continue
    }
    if (char === ';' || char === '?') {
      continue
    }
    return ''
  }
  return tail
}

export function terminalRewriteOutputPrefersRenderRefresh(data: string): boolean {
  if (data.includes('\b') || containsStandaloneCarriageReturn(data)) {
    return true
  }

  return containsRewriteEraseSequence(data)
}

export type TerminalRewriteOutputRenderRefreshDecision = {
  nextChunkEndsWithCarriageReturn: boolean
  nextRewriteCsiScanTail: string
  prefersRenderRefresh: boolean
}

export type TerminalRewriteOutputRenderRefreshState = {
  previousChunkEndsWithCarriageReturn: boolean
  previousRewriteCsiScanTail: string
}

export function terminalRewriteOutputRenderRefreshDecision(
  data: string,
  state: TerminalRewriteOutputRenderRefreshState
): TerminalRewriteOutputRenderRefreshDecision {
  if (!data) {
    return {
      nextChunkEndsWithCarriageReturn: state.previousChunkEndsWithCarriageReturn,
      nextRewriteCsiScanTail: state.previousRewriteCsiScanTail,
      prefersRenderRefresh: false
    }
  }
  const scanData = state.previousRewriteCsiScanTail
    ? `${state.previousRewriteCsiScanTail}${data}`
    : data
  return {
    nextChunkEndsWithCarriageReturn: data.endsWith('\r'),
    nextRewriteCsiScanTail: trailingIncompleteRewriteCsiTail(scanData),
    prefersRenderRefresh:
      (state.previousChunkEndsWithCarriageReturn && data[0] !== '\n') ||
      terminalRewriteOutputPrefersRenderRefresh(scanData)
  }
}

/** Native Windows ConPTY prompt rewrites (CR/CHA/erase/reprint without DEC 2026) can paint one frame late, leaving phantom/overwritten characters. Synchronous refresh races that paint; schedule a follow-up frame for in-place rewrites, avoiding costs on other platforms/plain output. */
export function nativeWindowsRewriteNeedsFollowupRenderRefresh(args: {
  isNativeWindowsConpty: boolean
  isForeground: boolean
  isInPlaceRewrite: boolean
}): boolean {
  return args.isNativeWindowsConpty && args.isForeground && args.isInPlaceRewrite
}

export function terminalOutputPrefersRenderRefresh(data: string): boolean {
  if (containsBackgroundSgr(data)) {
    return true
  }

  let hasNonAscii = false
  for (let i = 0; i < data.length; i += 1) {
    if (data.charCodeAt(i) > 0x7f) {
      hasNonAscii = true
      break
    }
  }
  if (!hasNonAscii) {
    // Most Codex redraws are ASCII; avoid Unicode regex/code-point scans on the hot path.
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

export function terminalOutputContainsEastAsianRendererRisk(data: string): boolean {
  for (let i = 0; i < data.length; i += 1) {
    const codePoint = data.codePointAt(i)
    if (codePoint === undefined) {
      continue
    }
    if (isEastAsianRendererRiskCodePoint(codePoint)) {
      return true
    }
    if (codePoint > 0xffff) {
      i += 1
    }
  }
  return false
}

export type WindowsEastAsianRefreshState = {
  // IME commits affect Windows clients; forced agent repaint remains native-ConPTY-only to avoid remote costs.
  isWindowsClient: boolean
  isNativeWindowsConpty: boolean
  hadRecentInput: boolean
  maxInteractiveRedrawChars: number
}

/**
 * Whether a Windows foreground chunk needs a viewport refresh because it carries
 * East Asian double-width glyphs the local DOM renderer can paint over stale cells.
 */
export function windowsEastAsianOutputPrefersRenderRefresh(
  data: string,
  state: WindowsEastAsianRefreshState
): boolean {
  const recentInputRefresh = state.isWindowsClient && state.hadRecentInput
  const agentOutputRefresh = state.isNativeWindowsConpty
  if (!recentInputRefresh && !agentOutputRefresh) {
    return false
  }
  if (data.length > state.maxInteractiveRedrawChars) {
    return false
  }
  return terminalOutputContainsEastAsianRendererRisk(data)
}
