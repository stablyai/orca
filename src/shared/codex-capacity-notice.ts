import { createTerminalEscapeScanner } from './terminal-escape-scanner'

export const CODEX_CAPACITY_MESSAGE = 'Selected model is at capacity. Please try a different model.'

const NOTICE = /^[\u25A0\u26A0]\s+Selected model is at capacity\. Please try a different model\.$/
const MAX_NOTICE_LENGTH = 160

/** Only a newly painted native notice at the end of the conversation can close a turn. */
export class CodexCapacityNoticeTracker {
  private tail = ''
  private pending = false
  private synchronized = false
  private readonly scanner = createTerminalEscapeScanner({
    onCsi: (marker, params, final) => {
      if (
        marker === '?' &&
        params.split(';').includes('2026') &&
        (final === 'h' || final === 'l')
      ) {
        this.synchronized = final === 'h'
      } else if ((final === 'H' || final === 'f') && this.tail && !this.tail.endsWith(' ')) {
        this.tail += ' '
      }
    },
    onText: (text) => this.observeText(text)
  })

  private observeText(text: string): void {
    if (this.tail) {
      this.updateCandidate(this.tail + text.slice(0, MAX_NOTICE_LENGTH))
    }
    let error = text.indexOf('■')
    let warning = text.indexOf('⚠')
    while (error !== -1 || warning !== -1) {
      const start = error === -1 ? warning : warning === -1 ? error : Math.min(error, warning)
      this.updateCandidate(text.slice(start, start + MAX_NOTICE_LENGTH))
      if (start === error) {
        error = text.indexOf('■', start + 1)
      } else {
        warning = text.indexOf('⚠', start + 1)
      }
    }
  }

  private updateCandidate(text: string): void {
    const content = text.slice(1).trimStart()
    if (content && content[0] !== CODEX_CAPACITY_MESSAGE[0]) {
      this.tail = ''
      return
    }
    const candidate = text.replace(/\s+/g, ' ')
    const message = candidate.slice(1).trimStart()
    if (message.startsWith(CODEX_CAPACITY_MESSAGE)) {
      this.pending = true
      this.tail = ''
    } else {
      this.tail = CODEX_CAPACITY_MESSAGE.startsWith(message) ? candidate : ''
    }
  }

  observe(
    data: string,
    readScreen: () => readonly string[],
    readSynchronized?: () => boolean
  ): boolean {
    this.scanner.observe(data)
    if (!this.pending || (readSynchronized?.() ?? this.synchronized)) {
      return false
    }
    this.pending = false
    this.tail = ''
    const lines = readScreen()
    const composer = lines.findLastIndex((line) => /^\s*\u203A/.test(line))
    if (composer === -1) {
      return false
    }
    const above = lines.slice(0, composer).filter((line) => line.trim() !== '')
    let notice = ''
    for (let index = above.length - 1; index >= 0 && notice.length < MAX_NOTICE_LENGTH; index--) {
      notice = `${above[index].trim()} ${notice}`.trim()
      if (NOTICE.test(notice)) {
        return true
      }
    }
    return false
  }
}
