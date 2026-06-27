// Why: some foreground ANSI redraws paint background fills before glyphs settle.
// Detect those chunks so the terminal can force a narrow viewport refresh
// without switching renderers based on the text content.
const EMOJI_PRESENTATION_PATTERN = /\p{Emoji_Presentation}/u
const ESCAPE_CHARACTER = String.fromCharCode(0x1b)
const REWRITE_CSI_SCAN_TAIL_MAX_CHARS = 64
const SGR_SEQUENCE_PATTERN = new RegExp(`${ESCAPE_CHARACTER}\\[([0-9:;]*)m`, 'g')

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

function containsBackgroundSgr(data: string): boolean {
  SGR_SEQUENCE_PATTERN.lastIndex = 0
  for (
    let match = SGR_SEQUENCE_PATTERN.exec(data);
    match;
    match = SGR_SEQUENCE_PATTERN.exec(data)
  ) {
    if (sgrSequenceSetsBackground(match[1] ?? '')) {
      return true
    }
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
    // Why: Codex-style terminal redraws are usually ASCII; avoid the Unicode
    // emoji/property regex and code-point walk on the hottest output path.
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
