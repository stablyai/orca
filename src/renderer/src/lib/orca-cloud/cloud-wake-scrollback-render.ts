// WAKE-SCROLLBACK: a pane's pre-sleep output as rendered text and attributes only. Built from the
// xterm buffer's cells (never its escape stream), so it carries text and SGR (`CSI … m`) and
// nothing else: no OSC (52 clipboard, 0 title), no modes, no cursor moves. `sanitizeRestoredText`
// enforces that again on whatever is written back, including the plain-text read-only copy.

/** The parts of an xterm buffer cell the renderer reads. */
export type RestoreCell = {
  getChars(): string
  getWidth(): number
  isBold(): number
  isDim(): number
  isItalic(): number
  isUnderline(): number
  isBlink(): number
  isInverse(): number
  isInvisible(): number
  isStrikethrough(): number
  isFgDefault(): boolean
  isFgPalette(): boolean
  isFgRGB(): boolean
  getFgColor(): number
  isBgDefault(): boolean
  isBgPalette(): boolean
  isBgRGB(): boolean
  getBgColor(): number
}

export type RestoreLine = {
  isWrapped: boolean
  length: number
  getCell(x: number): RestoreCell | undefined
}

export type RestoreBuffer = {
  length: number
  getLine(y: number): RestoreLine | undefined
}

function colorParams(
  kind: 'fg' | 'bg',
  isDefault: boolean,
  isPalette: boolean,
  isRgb: boolean,
  color: number
): string[] {
  if (isDefault) {
    return []
  }
  const base = kind === 'fg' ? 30 : 40
  if (isPalette) {
    if (color < 8) {
      return [String(base + color)]
    }
    if (color < 16) {
      return [String(base + 60 + color - 8)]
    }
    return [String(base + 8), '5', String(color)]
  }
  if (isRgb) {
    return [
      String(base + 8),
      '2',
      String((color >> 16) & 255),
      String((color >> 8) & 255),
      String(color & 255)
    ]
  }
  return []
}

/** The SGR parameters for a cell's attributes (empty for the default pen). */
export function cellSgrParams(cell: RestoreCell): string[] {
  const params: string[] = []
  const flags: [number, string][] = [
    [cell.isBold(), '1'],
    [cell.isDim(), '2'],
    [cell.isItalic(), '3'],
    [cell.isUnderline(), '4'],
    [cell.isBlink(), '5'],
    [cell.isInverse(), '7'],
    [cell.isInvisible(), '8'],
    [cell.isStrikethrough(), '9']
  ]
  for (const [on, code] of flags) {
    if (on) {
      params.push(code)
    }
  }
  params.push(
    ...colorParams('fg', cell.isFgDefault(), cell.isFgPalette(), cell.isFgRGB(), cell.getFgColor()),
    ...colorParams('bg', cell.isBgDefault(), cell.isBgPalette(), cell.isBgRGB(), cell.getBgColor())
  )
  return params
}

function renderLine(line: RestoreLine): string {
  let out = ''
  let pen = ''
  // Trailing default-pen blanks are padding, not output.
  let keep = 0
  const cells: { chars: string; pen: string }[] = []
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x)
    if (!cell || cell.getWidth() === 0) {
      continue
    }
    const cellPen = cellSgrParams(cell).join(';')
    const chars = cell.getChars() || ' '
    cells.push({ chars, pen: cellPen })
    if (chars !== ' ' || cellPen !== '') {
      keep = cells.length
    }
  }
  for (const cell of cells.slice(0, keep)) {
    if (cell.pen !== pen) {
      out += cell.pen === '' ? '\x1b[0m' : `\x1b[0;${cell.pen}m`
      pen = cell.pen
    }
    out += cell.chars
  }
  return pen === '' ? out : `${out}\x1b[0m`
}

/** Rows `[from, to)` of a buffer as text + SGR; wrapped rows join their line, others end in CRLF. */
export function renderBufferRows(buffer: RestoreBuffer, from: number, to: number): string {
  let out = ''
  for (let y = Math.max(0, from); y < Math.min(to, buffer.length); y++) {
    const line = buffer.getLine(y)
    if (!line) {
      continue
    }
    if (y > from && !line.isWrapped) {
      out += '\r\n'
    }
    out += renderLine(line)
  }
  return out
}

/** `renderBufferRows` in 1000-row chunks, yielding between them (off the input path). */
export async function renderBufferRowsAsync(
  buffer: RestoreBuffer,
  from: number,
  to: number,
  chunk = 1000
): Promise<string> {
  let out = ''
  for (let start = Math.max(0, from); start < to; start += chunk) {
    const end = Math.min(to, start + chunk)
    if (start > from && !buffer.getLine(start)?.isWrapped) {
      out += '\r\n'
    }
    out += renderBufferRows(buffer, start, end)
    if (end < to) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  }
  return out
}

const ESC = '\x1b'
const BEL = '\x07'

/** A CSI body starting at `start` (after ESC [ or C1 CSI): its end index and whether it is SGR. */
function readCsi(text: string, start: number): { end: number; sgr: boolean } {
  let end = start
  while (end < text.length && /[0-?]/.test(text[end]!)) {
    end++
  }
  while (end < text.length && /[ -/]/.test(text[end]!)) {
    end++
  }
  return { end, sgr: text[end] === 'm' && /^[0-9;:]*$/.test(text.slice(start, end)) }
}

/** Index just past a string control (OSC/DCS/SOS/PM/APC) starting at `start`, or the end. */
function skipStringControl(text: string, start: number): number {
  for (let index = start; index < text.length; index++) {
    if (text[index] === BEL) {
      return index + 1
    }
    if (text[index] === ESC && text[index + 1] === '\\') {
      return index + 2
    }
  }
  return text.length
}

/**
 * Text and SGR only: every other escape (OSC 52 / OSC 0, DECSET, bracketed paste, cursor moves,
 * erases, charset and keypad modes) and every C0/C1 control but tab, CR and LF is dropped.
 */
export function sanitizeRestoredText(text: string): string {
  let out = ''
  let index = 0
  while (index < text.length) {
    const char = text[index]!
    const code = char.charCodeAt(0)
    if (char === ESC) {
      const next = text[index + 1]
      if (next === '[') {
        const csi = readCsi(text, index + 2)
        if (csi.sgr) {
          out += text.slice(index, csi.end + 1)
        }
        index = csi.end + 1
        continue
      }
      if (next === ']' || next === 'P' || next === 'X' || next === '^' || next === '_') {
        index = skipStringControl(text, index + 2)
        continue
      }
      // ESC + intermediates + final (charset designations, keypad modes, RIS, DECSC/DECRC).
      let end = index + 1
      while (end < text.length && /[ -/]/.test(text[end]!)) {
        end++
      }
      index = end + 1
      continue
    }
    if ((code < 0x20 && char !== '\t' && char !== '\r' && char !== '\n') || code === 0x7f) {
      index++
      continue
    }
    if (code >= 0x80 && code <= 0x9f) {
      // C1 controls, dropped with their sequences: CSI (0x9b), and OSC/DCS/SOS/PM/APC strings.
      if (code === 0x9b) {
        index = readCsi(text, index + 1).end + 1
      } else if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) {
        index = skipStringControl(text, index + 1)
      } else {
        index++
      }
      continue
    }
    out += char
    index++
  }
  return out
}

/**
 * "2:02–2:31 PM" / "11:50 AM–12:10 PM" / "14:02–14:31": the locale's short times, no leading zero,
 * a shared AM/PM said once; across days each side keeps its weekday ("Mon 11:50 PM–Tue 12:10 AM").
 */
export function formatSleptRange(from: number, to: number, locale?: string): string {
  const sameDay = new Date(from).toDateString() === new Date(to).toDateString()
  const format = new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
    ...(sameDay ? {} : { weekday: 'short' })
  })
  return format.formatRange(Math.min(from, to), to).replace(/\s*[–-]\s*/u, '–')
}
