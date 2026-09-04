// Why: some foreground ANSI redraws paint background fills before glyphs settle.
// Detect those chunks so the terminal can force a narrow viewport refresh
// without switching renderers based on the text content.
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
    // Why: keep this list available for targeted refresh decisions without
    // turning Unicode output into a renderer-selection signal.
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

/** End of the `[0-9:;]*` parameter run the SGR pattern accepts, starting at `start`. */
function sgrParameterRunEnd(data: string, start: number): number {
  let index = start
  while (index < data.length) {
    const code = data.charCodeAt(index)
    if ((code >= 0x30 && code <= 0x39) || code === 0x3a || code === 0x3b) {
      index += 1
      continue
    }
    break
  }
  return index
}

/** `sgrSequenceSetsBackground` over a substring range, so no parameter string is materialized. */
function sgrRangeSetsBackground(data: string, start: number, end: number): boolean {
  let partStart = start
  for (;;) {
    let partEnd = partStart
    while (partEnd < end && data.charCodeAt(partEnd) !== 0x3b) {
      partEnd += 1
    }
    const value = sgrParamCodeInRange(data, partStart, partEnd)
    let extraParts = 0
    if (value !== null) {
      if (isInRange(value, 40, 47) || isInRange(value, 100, 107) || value === 48) {
        return true
      }
      if (value === 38 && !rangeIncludesColon(data, partStart, partEnd)) {
        const nextEnd = nextPartEnd(data, partEnd + 1, end)
        const mode = nextEnd === -1 ? null : sgrParamCodeInRange(data, partEnd + 1, nextEnd)
        extraParts = mode === 5 ? 2 : mode === 2 ? 4 : 1
      }
    }
    let remainingSkips = 1 + extraParts
    let cursor = partEnd
    while (remainingSkips > 0) {
      if (cursor >= end) {
        // Ran off the end of the parameter list, exactly as the old index loop did.
        return false
      }
      cursor += 1
      remainingSkips -= 1
      if (remainingSkips > 0) {
        while (cursor < end && data.charCodeAt(cursor) !== 0x3b) {
          cursor += 1
        }
      }
    }
    partStart = cursor
  }
}

function nextPartEnd(data: string, start: number, end: number): number {
  if (start > end) {
    return -1
  }
  let index = start
  while (index < end && data.charCodeAt(index) !== 0x3b) {
    index += 1
  }
  return index
}

function rangeIncludesColon(data: string, start: number, end: number): boolean {
  for (let index = start; index < end; index++) {
    if (data.charCodeAt(index) === 0x3a) {
      return true
    }
  }
  return false
}

/** `sgrParamCode` over a range: null for an empty part or a part with no leading digits. */
function sgrParamCodeInRange(data: string, start: number, end: number): number | null {
  let index = start
  let value = 0
  let digits = 0
  while (index < end) {
    const code = data.charCodeAt(index)
    if (code === 0x3a) {
      break
    }
    value = value * 10 + (code - 0x30)
    digits += 1
    index += 1
  }
  return digits === 0 ? null : value
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
      // Why: erase-in-line/screen rewrites can leave stale renderer cells until
      // the next resize; xterm's buffer is correct, but the visible layer needs repainting.
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

/**
 * Whether a native-Windows ConPTY foreground chunk that forces a render refresh
 * should ALSO schedule a follow-up next-frame repaint.
 *
 * Why: Claude Code echoes prompt keystrokes by redrawing the input line in place
 * (CR + CHA/erase + reprint) without DEC 2026 synchronized output. xterm's buffer
 * ends up correct, but its DOM renderer can paint these rapid rewrites one frame
 * late — surfacing a phantom first char or an overwritten cell ("zzzx" rendered as
 * "zzx") that only a window resize clears. A single synchronous refresh races that
 * late paint; a follow-up next-frame repaint corrects the column desync the way the
 * existing cursor-restore and scroll cases already do. Scoped to in-place rewrites
 * on native Windows so plain shells and non-Windows renderers are unaffected.
 */
export function nativeWindowsRewriteNeedsFollowupRenderRefresh(args: {
  isNativeWindowsConpty: boolean
  isForeground: boolean
  isInPlaceRewrite: boolean
}): boolean {
  return args.isNativeWindowsConpty && args.isForeground && args.isInPlaceRewrite
}

/**
 * The classification is an OR of independent predicates, so one walk answers
 * the background-SGR scan, the non-ASCII gate and the renderer-risk code-point
 * cascade together. The emoji property regex still runs last, and only when the
 * chunk has non-ASCII at all — no ASCII code point has Emoji_Presentation, and
 * every renderer-risk range starts above U+007F, so the gate is unchanged.
 */
export function terminalOutputPrefersRenderRefresh(data: string): boolean {
  let hasNonAscii = false
  for (let i = 0; i < data.length; i += 1) {
    const code = data.charCodeAt(i)
    if (code > 0x7f) {
      hasNonAscii = true
      const codePoint = data.codePointAt(i) ?? code
      if (isRendererRiskCodePoint(codePoint)) {
        return true
      }
      if (codePoint > 0xffff) {
        i += 1
      }
      continue
    }
    if (code === 0x1b && data.charCodeAt(i + 1) === 0x5b) {
      const parametersEnd = sgrParameterRunEnd(data, i + 2)
      if (
        data.charCodeAt(parametersEnd) === 0x6d &&
        sgrRangeSetsBackground(data, i + 2, parametersEnd)
      ) {
        return true
      }
      // Deliberately resumes at i + 1: a nested ESC[ inside a run that is not an
      // SGR sequence was found by the old global regex too.
    }
  }
  if (!hasNonAscii) {
    return false
  }
  return EMOJI_PRESENTATION_PATTERN.test(data)
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
  // Why: recent IME commits are a Windows-client renderer issue, while agent
  // output repainting is only forced for native ConPTY to avoid remote costs.
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
