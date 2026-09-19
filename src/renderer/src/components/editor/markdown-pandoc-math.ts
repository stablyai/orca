import katex from 'katex'

const INLINE_MATH_PATTERN = /^\$(?![\s$])((?:\\[\s\S]|[^$\\])*?)(?<!\s)\$(?!\d)/
const BLOCK_MATH_OPEN_PATTERN = /^[ \t]*\$\$/

export type PandocMathMatch = {
  raw: string
  latex: string
}

export type PandocMathSpan = {
  kind: 'inline' | 'block'
  start: number
  end: number
  latex: string
}

export function matchPandocInlineMath(src: string): PandocMathMatch | undefined {
  const match = src.match(INLINE_MATH_PATTERN)
  const latex = match?.[1]
  if (!match || latex === undefined || !isRenderableInlineLatex(latex)) {
    return undefined
  }
  return { raw: match[0], latex }
}

export function matchPandocBlockMath(src: string): PandocMathMatch | undefined {
  const open = BLOCK_MATH_OPEN_PATTERN.exec(src)
  if (!open) {
    return undefined
  }
  const bodyStart = open[0].length
  const close = indexOfUnescapedDoubleDollar(src, bodyStart)
  if (close <= bodyStart) {
    return undefined
  }
  return { raw: src.slice(0, close + 2), latex: src.slice(bodyStart, close).trim() }
}

export function findPandocMathSpans(src: string): PandocMathSpan[] {
  const spans: PandocMathSpan[] = []
  let i = 0
  while (i < src.length) {
    if (src[i] === '\\') {
      i += 2
      continue
    }
    const atLineStart = i === 0 || src[i - 1] === '\n'
    if (atLineStart) {
      const block = matchPandocBlockMath(src.slice(i))
      if (block) {
        spans.push({ kind: 'block', start: i, end: i + block.raw.length, latex: block.latex })
        i += block.raw.length
        continue
      }
    }
    const inline = matchPandocInlineMath(src.slice(i))
    if (inline) {
      spans.push({ kind: 'inline', start: i, end: i + inline.raw.length, latex: inline.latex })
      i += inline.raw.length
      continue
    }
    i += 1
  }
  return spans
}

export function blockMathStartIndex(src: string): number {
  const open = /\n[ \t]*\$\$/g
  let match = open.exec(src)
  while (match) {
    const bodyStart = match.index + match[0].length
    const close = indexOfUnescapedDoubleDollar(src, bodyStart)
    if (close > bodyStart) {
      return match.index
    }
    match = open.exec(src)
  }
  return -1
}

function indexOfUnescapedDoubleDollar(src: string, from: number): number {
  let i = from
  while (i < src.length) {
    if (src[i] === '\\') {
      i += 2
      continue
    }
    if (src[i] === '$' && src[i + 1] === '$') {
      return i
    }
    i += 1
  }
  return -1
}

export function protectNonMathDollars(src: string): string {
  const masked = new Uint8Array(src.length)
  for (const span of findPandocMathSpans(src)) {
    masked.fill(1, span.start, span.end)
  }
  maskAlreadyEscapedDollars(src, masked)
  maskCodeRegions(src, masked)

  let out = ''
  for (let i = 0; i < src.length; i += 1) {
    out += src[i] === '$' && masked[i] === 0 ? '\\$' : src[i]
  }
  return out
}

function isRenderableInlineLatex(latex: string): boolean {
  try {
    katex.renderToString(latex, { throwOnError: true, output: 'mathml' })
    return true
  } catch {
    return false
  }
}

function maskAlreadyEscapedDollars(src: string, masked: Uint8Array): void {
  let i = 0
  while (i < src.length) {
    if (src[i] === '\\') {
      if (src[i + 1] === '$') {
        masked[i + 1] = 1
      }
      i += 2
      continue
    }
    i += 1
  }
}

function maskCodeRegions(src: string, masked: Uint8Array): void {
  let i = 0
  while (i < src.length) {
    const fenceEnd = fenceRegionEnd(src, i)
    if (fenceEnd !== null) {
      masked.fill(1, i, fenceEnd)
      i = fenceEnd
      continue
    }
    const codeEnd = inlineCodeEnd(src, i)
    if (codeEnd !== null) {
      masked.fill(1, i, codeEnd)
      i = codeEnd
      continue
    }
    i += 1
  }
}

function fenceRegionEnd(src: string, i: number): number | null {
  if (i !== 0 && src[i - 1] !== '\n') {
    return null
  }
  let k = skipContainerPrefix(src, i)
  let indent = 0
  while (k < src.length && indent < 3 && (src[k] === ' ' || src[k] === '\t')) {
    indent += 1
    k += 1
  }
  const marker = src[k]
  if (marker !== '`' && marker !== '~') {
    return null
  }
  let len = 0
  while (k < src.length && src[k] === marker) {
    len += 1
    k += 1
  }
  if (len < 3) {
    return null
  }
  while (k < src.length && src[k] !== '\n') {
    k += 1
  }
  if (k < src.length) {
    k += 1
  }
  while (k < src.length) {
    let c = skipContainerPrefix(src, k)
    let closeIndent = 0
    while (c < src.length && closeIndent < 3 && (src[c] === ' ' || src[c] === '\t')) {
      closeIndent += 1
      c += 1
    }
    let closeLen = 0
    while (c < src.length && src[c] === marker) {
      closeLen += 1
      c += 1
    }
    if (closeLen >= len) {
      while (c < src.length && src[c] !== '\n' && (src[c] === ' ' || src[c] === '\t')) {
        c += 1
      }
      if (c === src.length || src[c] === '\n') {
        return c === src.length ? c : c + 1
      }
    }
    while (k < src.length && src[k] !== '\n') {
      k += 1
    }
    if (k < src.length) {
      k += 1
    }
  }
  return src.length
}

function skipContainerPrefix(src: string, i: number): number {
  let k = i
  for (;;) {
    let s = k
    let pad = 0
    while (s < src.length && pad < 3 && (src[s] === ' ' || src[s] === '\t')) {
      pad += 1
      s += 1
    }
    if (src[s] !== '>') {
      break
    }
    k = s + 1
    if (src[k] === ' ' || src[k] === '\t') {
      k += 1
    }
  }
  let s = k
  let pad = 0
  while (s < src.length && pad < 3 && (src[s] === ' ' || src[s] === '\t')) {
    pad += 1
    s += 1
  }
  const ch = src[s]
  if ((ch === '-' || ch === '*' || ch === '+') && (src[s + 1] === ' ' || src[s + 1] === '\t')) {
    return s + 2
  }
  let digits = s
  while (digits < src.length && src[digits] >= '0' && src[digits] <= '9') {
    digits += 1
  }
  if (
    digits > s &&
    (src[digits] === '.' || src[digits] === ')') &&
    (src[digits + 1] === ' ' || src[digits + 1] === '\t')
  ) {
    return digits + 2
  }
  return k
}

function inlineCodeEnd(src: string, i: number): number | null {
  if (src[i] !== '`') {
    return null
  }
  let n = 0
  while (i + n < src.length && src[i + n] === '`') {
    n += 1
  }
  let j = i + n
  while (j < src.length) {
    if (src[j] === '\n') {
      let k = j + 1
      while (k < src.length && (src[k] === ' ' || src[k] === '\t')) {
        k += 1
      }
      if (k === src.length || src[k] === '\n') {
        return null
      }
    }
    if (src[j] !== '`') {
      j += 1
      continue
    }
    let m = 0
    while (j + m < src.length && src[j + m] === '`') {
      m += 1
    }
    if (m === n) {
      return j + m
    }
    j += m
  }
  return null
}
