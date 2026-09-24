import { stripAnsiEscapeSequences } from '../../../../shared/ansi-escape-sequences'

/** 0-15 index the themed ANSI palette; strings are explicit CSS colors. */
export type AnsiColor = number | string

export type AnsiStyle = {
  fg?: AnsiColor
  bg?: AnsiColor
  bold?: boolean
  italic?: boolean
  underline?: boolean
}

export type AnsiSegment = AnsiStyle & { text: string }

// oxlint-disable-next-line no-control-regex -- matches the ESC byte that introduces SGR sequences.
const SGR_PATTERN = /\u001b\[([0-9;]*)m/g

function xterm256Color(index: number): AnsiColor {
  if (index < 16) {
    return index
  }
  if (index >= 232) {
    const level = 8 + (index - 232) * 10
    return `rgb(${level}, ${level}, ${level})`
  }
  const cube = index - 16
  const level = (value: number): number => (value === 0 ? 0 : 55 + value * 40)
  return `rgb(${level(Math.floor(cube / 36))}, ${level(Math.floor(cube / 6) % 6)}, ${level(cube % 6)})`
}

function applySgr(style: AnsiStyle, params: string): AnsiStyle {
  const codes = params === '' ? [0] : params.split(';').map(Number)
  let next = { ...style }
  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i]
    if (code === 0) {
      next = {}
    } else if (code === 1) {
      next.bold = true
    } else if (code === 3) {
      next.italic = true
    } else if (code === 4) {
      next.underline = true
    } else if (code === 22) {
      next.bold = undefined
    } else if (code === 23) {
      next.italic = undefined
    } else if (code === 24) {
      next.underline = undefined
    } else if (code >= 30 && code <= 37) {
      next.fg = code - 30
    } else if (code >= 90 && code <= 97) {
      next.fg = code - 90 + 8
    } else if (code === 39) {
      next.fg = undefined
    } else if (code >= 40 && code <= 47) {
      next.bg = code - 40
    } else if (code >= 100 && code <= 107) {
      next.bg = code - 100 + 8
    } else if (code === 49) {
      next.bg = undefined
    } else if (code === 38 || code === 48) {
      const key = code === 38 ? 'fg' : 'bg'
      if (codes[i + 1] === 5 && codes[i + 2] !== undefined) {
        next[key] = xterm256Color(codes[i + 2])
        i += 2
      } else if (codes[i + 1] === 2 && codes[i + 4] !== undefined) {
        next[key] = `rgb(${codes[i + 2]}, ${codes[i + 3]}, ${codes[i + 4]})`
        i += 4
      }
    }
  }
  return next
}

/** Splits terminal output into styled runs; non-SGR escape sequences are dropped. */
export function parseAnsiSegments(input: string): AnsiSegment[] {
  const segments: AnsiSegment[] = []
  let style: AnsiStyle = {}
  let offset = 0
  const pushText = (raw: string): void => {
    const text = stripAnsiEscapeSequences(raw)
    if (text) {
      segments.push({ ...style, text })
    }
  }
  for (const match of input.matchAll(SGR_PATTERN)) {
    pushText(input.slice(offset, match.index))
    style = applySgr(style, match[1])
    offset = match.index + match[0].length
  }
  pushText(input.slice(offset))
  return segments
}
