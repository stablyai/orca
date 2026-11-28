// Strip Kitty APC graphics payloads (ESC _ G ... ST/CAN/SUB) before text/escape scanners inspect chunks.
// oxlint-disable-next-line no-control-regex -- VT500 APC strings end only on CAN, SUB, or ESC.
const KITTY_APC_CONTROL_SCAN = /[\x18\x1a\x1b]/g

const KITTY_APC_PREFIX = '\x1b_G'
const STRING_TERMINATOR = '\x1b\\'

const ESC = 0x1b
const CAN = 0x18
const SUB = 0x1a
const BACKSLASH = 0x5c
const UNDERSCORE = 0x5f
const UPPER_G = 0x47

type FilterState = 'ground' | 'inKittyApc' | 'inKittyApcEsc'
type PendingIntroducer = '' | '\x1b' | '\x1b_'

function trailingIntroducer(text: string): PendingIntroducer {
  if (text.endsWith('\x1b_')) {
    return '\x1b_'
  }
  if (text.endsWith('\x1b')) {
    return '\x1b'
  }
  return ''
}

export class TerminalKittyApcFilter {
  private state: FilterState = 'ground'
  private pendingIntroducer: PendingIntroducer = ''

  reset(): void {
    this.state = 'ground'
    this.pendingIntroducer = ''
  }

  filter(data: string): string {
    if (data.length === 0) {
      return ''
    }
    // Common case: ground state with no Kitty APC introducer returns the input string untouched.
    if (
      this.state === 'ground' &&
      this.pendingIntroducer === '' &&
      !data.includes(KITTY_APC_PREFIX)
    ) {
      this.pendingIntroducer = trailingIntroducer(data)
      return data
    }

    const hasCanOrSub = data.includes('\x18') || data.includes('\x1a')
    const parts: string[] = []
    let pos = 0
    let emitted = false
    const carryPending = this.state === 'ground' ? this.pendingIntroducer : ''

    if (this.state === 'ground' && this.pendingIntroducer !== '') {
      if (this.pendingIntroducer === '\x1b') {
        if (data === '_') {
          this.pendingIntroducer = '\x1b_'
          return data
        }
        if (data.startsWith('_G')) {
          this.pendingIntroducer = ''
          this.state = 'inKittyApc'
          parts.push(STRING_TERMINATOR)
          emitted = true
          pos = 2
        } else {
          this.pendingIntroducer = ''
        }
      } else {
        if (data.startsWith('G')) {
          this.pendingIntroducer = ''
          this.state = 'inKittyApc'
          parts.push(STRING_TERMINATOR)
          emitted = true
          pos = 1
        } else {
          this.pendingIntroducer = ''
        }
      }
    }

    while (pos < data.length) {
      if (this.state === 'ground') {
        const start = data.indexOf(KITTY_APC_PREFIX, pos)
        if (start === -1) {
          parts.push(pos === 0 ? data : data.slice(pos))
          emitted = true
          break
        }
        if (start > pos) {
          parts.push(data.slice(pos, start))
          emitted = true
        } else if (!emitted && carryPending !== '') {
          parts.push(STRING_TERMINATOR)
          emitted = true
        }
        this.state = 'inKittyApc'
        pos = start + 3
        continue
      }

      if (this.state === 'inKittyApc') {
        if (!hasCanOrSub) {
          const esc = data.indexOf('\x1b', pos)
          if (esc === -1) {
            pos = data.length
            break
          }
          if (esc + 1 < data.length && data.charCodeAt(esc + 1) === BACKSLASH) {
            this.state = 'ground'
            pos = esc + 2
            continue
          }
          this.state = 'inKittyApcEsc'
          pos = esc + 1
          continue
        }
        KITTY_APC_CONTROL_SCAN.lastIndex = pos
        const match = KITTY_APC_CONTROL_SCAN.exec(data)
        if (!match) {
          pos = data.length
          break
        }
        const controlIndex = match.index
        this.state = data.charCodeAt(controlIndex) === ESC ? 'inKittyApcEsc' : 'ground'
        pos = controlIndex + 1
        continue
      }

      // state === 'inKittyApcEsc'
      const code = data.charCodeAt(pos)
      if (code === BACKSLASH || code === CAN || code === SUB) {
        this.state = 'ground'
        pos += 1
        continue
      }
      if (code === ESC) {
        this.state = 'ground'
        continue
      }
      if (code === UNDERSCORE) {
        if (pos + 1 < data.length && data.charCodeAt(pos + 1) === UPPER_G) {
          this.state = 'inKittyApc'
          pos += 2
          continue
        }
        if (pos + 1 === data.length) {
          parts.push('\x1b_')
          this.pendingIntroducer = '\x1b_'
          this.state = 'ground'
          return parts.join('')
        }
      }
      parts.push('\x1b')
      emitted = true
      this.state = 'ground'
    }

    if (this.state === 'ground') {
      const last = parts.at(-1)
      this.pendingIntroducer = last ? trailingIntroducer(last) : ''
    } else {
      this.pendingIntroducer = ''
    }

    return parts.length === 0 ? '' : parts.length === 1 ? parts[0] : parts.join('')
  }
}
