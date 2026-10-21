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
