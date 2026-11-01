const ESC = '\x1b'
// Longest unfinished escape carried into the next read; anything longer is noise, not a split.
const MAX_CARRIED_ESCAPE_CHARS = 512

/* oxlint-disable no-control-regex -- these match terminal escape sequences, which start with ESC */
const CSI_RE = /^\x1b\[([?>=<]?)([0-9;]*)([ -/]*[@-~])/
const UNFINISHED_CSI_RE = /^\x1b\[[?>=<]?[0-9;]*[ -/]*$/
// Terminal control strings (titles, graphics, queries) never paint their payload text.
const STRING_RE = /^\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\)/
const STRING_START_RE = /^\x1b[\]PX^_]/
const STRING_END_RE = /\x07|\x1b\\/

type TerminalEscapeObserver = {
  onCsi: (privateMarker: string, params: string, final: string) => void
  onText: (text: string) => void
}

/** Incremental painted-text/CSI reader; terminal string payloads are never painted text. */
export function createTerminalEscapeScanner(observer: TerminalEscapeObserver): {
  observe: (data: string) => void
} {
  let carry = ''
  let stringPending = false
  return {
    observe(data: string): void {
      const input = carry + data
      carry = ''
      let index = 0
      if (stringPending) {
        const end = STRING_END_RE.exec(input)
        if (!end) {
          carry = input.endsWith(ESC) ? ESC : ''
          return
        }
        stringPending = false
        index = end.index + end[0].length
      }
      while (index < input.length) {
        const escapeAt = input.indexOf(ESC, index)
        if (escapeAt === -1) {
          observer.onText(input.slice(index))
          break
        }
        observer.onText(input.slice(index, escapeAt))
        const rest = input.slice(escapeAt)
        const sequence = CSI_RE.exec(rest) ?? STRING_RE.exec(rest)
        if (sequence) {
          if (sequence[0][1] === '[') {
            observer.onCsi(sequence[1], sequence[2], sequence[3])
          }
          index = escapeAt + sequence[0].length
          continue
        }
        if (STRING_START_RE.test(rest)) {
          stringPending = true
          carry = rest.endsWith(ESC) ? ESC : ''
          break
        }
        if (isUnfinishedEscape(rest)) {
          carry = rest
          break
        }
        index = escapeAt + 2
      }
    }
  }
}

function isUnfinishedEscape(rest: string): boolean {
  if (rest.length > MAX_CARRIED_ESCAPE_CHARS) {
    return false
  }
  return (
    rest === ESC ||
    UNFINISHED_CSI_RE.test(rest) ||
    (STRING_START_RE.test(rest) && !STRING_END_RE.test(rest))
  )
}

/** Strict painted-text mode; every control interrupts a receipt, including a torn introducer. */
export function createStrictTerminalEscapeScanner(observer: {
  onText: (text: string) => void
  onControl: (control: string, ground: boolean) => void
}): { observe: (data: string) => void } {
  type Mode =
    | 'ground'
    | 'escape'
    | 'escapeIntermediate'
    | 'csi'
    | 'csiIgnore'
    | 'csiIntermediate'
    | 'dcs'
    | 'dcsIgnore'
    | 'dcsIntermediate'
    | 'dcsBody'
    | 'osc'
    | 'string'
    | 'apc'
    | 'apcBody'
  let mode: Mode = 'ground'
  let parameter = false
  return {
    observe(data): void {
      for (const ch of data) {
        const code = ch.codePointAt(0)!
        const ground = mode === 'ground'
        if (ground && code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) {
          observer.onText(ch)
          continue
        }
        observer.onControl(ch, ground)
        // The engine's anywhere transitions precede each state's local table.
        if (code === 0x1b) {
          mode = 'escape'
          parameter = false
          continue
        }
        if (code === 0x9b || code === 0x90) {
          mode = code === 0x9b ? 'csi' : 'dcs'
          parameter = false
          continue
        }
        if (code === 0x9d) {
          mode = 'osc'
          continue
        }
        if (code === 0x98 || code === 0x9e || code === 0x9f) {
          mode = code === 0x9f ? 'apc' : 'string'
          continue
        }
        if (code === 0x18 || code === 0x1a || (code >= 0x80 && code <= 0x9f)) {
          mode = 'ground'
          continue
        }
        if (mode === 'osc') {
          if (code === 7) {
            mode = 'ground'
          }
          continue
        }
        if (mode === 'string') {
          if (code >= 0xa0) {
            mode = 'ground'
          }
          continue
        }
        if (mode === 'dcsBody' || mode === 'dcsIgnore' || mode === 'apcBody') {
          continue
        }
        if (mode === 'apc') {
          if (code >= 0xa0) {
            mode = 'ground'
          } else if (code >= 0x30 && code <= 0x7e) {
            mode = 'apcBody'
          }
          continue
        }
        if (code < 0x20 || code === 0x7f) {
          continue
        }
        if (mode === 'escape') {
          if (ch === ']') {
            mode = 'osc'
          } else if (ch === '[' || ch === 'P') {
            mode = ch === '[' ? 'csi' : 'dcs'
          } else if (ch === 'X' || ch === '^' || ch === '_') {
            mode = ch === '_' ? 'apc' : 'string'
          } else {
            mode = code <= 0x2f ? 'escapeIntermediate' : 'ground'
          }
          continue
        }
        if (mode === 'escapeIntermediate') {
          if (code >= 0x30) {
            mode = 'ground'
          }
          continue
        }
        if (mode === 'ground') {
          continue
        }
        const dcs = mode === 'dcs' || mode === 'dcsIntermediate'
        if (code >= 0x40 && code <= 0x7e) {
          mode = dcs ? 'dcsBody' : 'ground'
        } else if (code >= 0xa0) {
          if (mode !== 'csiIgnore') {
            mode = 'ground'
          }
        } else if (code <= 0x2f) {
          if (mode !== 'csiIgnore') {
            mode = dcs ? 'dcsIntermediate' : 'csiIntermediate'
          }
        } else if (
          mode === 'csiIntermediate' ||
          mode === 'dcsIntermediate' ||
          (parameter && code >= 0x3c)
        ) {
          mode = dcs ? 'dcsIgnore' : 'csiIgnore'
        } else {
          parameter = true
        }
      }
    }
  }
}
