const ESC = '\x1b'
// Longest unfinished escape carried into the next read; anything longer is noise, not a split.
const MAX_CARRIED_ESCAPE_CHARS = 512

/* oxlint-disable no-control-regex -- these match terminal escape sequences, which start with ESC */
const CSI_STICKY_RE = /\x1b\[([?>=<]?)([0-9;]*)([ -/]*[@-~])/y
const UNFINISHED_CSI_RE = /^\x1b\[[?>=<]?[0-9;]*[ -/]*$/
const CONTROL_STRING_END_RE = /\x07|\x1b\\/g

type TerminalEscapeObserver = {
  onCsi: (privateMarker: string, params: string, final: string) => void
  onText: (text: string) => void
}

function isControlStringIntroducer(code: number): boolean {
  // OSC (]), DCS (P), SOS (X), PM (^), APC (_); none paint payload text.
  return code === 0x5d || code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f
}

function findControlStringEnd(input: string, from: number): number {
  CONTROL_STRING_END_RE.lastIndex = from
  const match = CONTROL_STRING_END_RE.exec(input)
  return match ? match.index + match[0].length : -1
}

/** Incremental painted-text/CSI reader; terminal string payloads are never painted text. */
export function createTerminalEscapeScanner(observer: TerminalEscapeObserver): {
  observe: (data: string) => void
} {
  let carry = ''
  let stringPending = false
  return {
    observe(data: string): void {
      const input = carry ? carry + data : data
      carry = ''
      let index = 0
      if (stringPending) {
        const end = findControlStringEnd(input, 0)
        if (end === -1) {
          carry = input.endsWith(ESC) ? ESC : ''
          return
        }
        stringPending = false
        index = end
      }
      while (index < input.length) {
        const escapeAt = input.indexOf(ESC, index)
        if (escapeAt === -1) {
          observer.onText(input.slice(index))
          break
        }
        observer.onText(input.slice(index, escapeAt))
        if (escapeAt + 1 >= input.length) {
          carry = ESC
          break
        }
        const next = input.charCodeAt(escapeAt + 1)
        if (isControlStringIntroducer(next)) {
          const end = findControlStringEnd(input, escapeAt + 2)
          if (end !== -1) {
            index = end
            continue
          }
          stringPending = true
          carry = input.endsWith(ESC) ? ESC : ''
          break
        }
        if (next === 0x5b) {
          CSI_STICKY_RE.lastIndex = escapeAt
          const sequence = CSI_STICKY_RE.exec(input)
          if (sequence) {
            observer.onCsi(sequence[1], sequence[2], sequence[3])
            index = CSI_STICKY_RE.lastIndex
            continue
          }
          if (input.length - escapeAt <= MAX_CARRIED_ESCAPE_CHARS) {
            const rest = input.slice(escapeAt)
            if (UNFINISHED_CSI_RE.test(rest)) {
              carry = rest
              break
            }
          }
        }
        index = escapeAt + 2
      }
    }
  }
}
