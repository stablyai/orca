import { createTerminalEscapeScanner } from './terminal-escape-scanner'

export const CODEX_CAPACITY_MESSAGE = 'Selected model is at capacity. Please try a different model.'

// Matched only behind Codex's \u25A0 error glyph, so quoting the sentence never counts.
export const CODEX_RECONNECT_FAILED_MESSAGE = 'Automatic reconnect could not restore this session.'

const NOTICE = /^[\u25A0\u26A0]\s+Selected model is at capacity\. Please try a different model\.$/
const MAX_NOTICE_LENGTH = 160

/** Only a newly painted native notice at the end of the conversation can close a turn. */
function capacityNoticeAboveComposer(lines: readonly string[]): boolean {
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

/** Codex paints its error cell at column 0 (history_cell/notices.rs new_error_event); indented echoes are output. */
function reconnectFailedNoticeOnScreen(lines: readonly string[]): boolean {
  const notice = `\u25A0 ${CODEX_RECONNECT_FAILED_MESSAGE}`
  return lines.some(
    (line, index) =>
      line.startsWith('\u25A0 ') &&
      lines
        .slice(index, index + 8)
        .join(' ')
        .replace(/\s+/g, ' ')
        .startsWith(notice)
  )
}

/** Streams Codex's native error/warning cells: a glyph-led message, confirmed on the settled screen. */
export class CodexNoticeTracker {
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
    if (content && content[0] !== this.message[0]) {
      this.tail = ''
      return
    }
    const candidate = text.replace(/\s+/g, ' ')
    const message = candidate.slice(1).trimStart()
    if (message.startsWith(this.message)) {
      this.pending = true
      this.tail = ''
    } else {
      this.tail = this.message.startsWith(message) ? candidate : ''
    }
  }

  constructor(
    private readonly message: string,
    private readonly confirm: (screen: readonly string[]) => boolean
  ) {}

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
    return this.confirm(readScreen())
  }
}

export const createCodexCapacityNoticeTracker = (): CodexNoticeTracker =>
  new CodexNoticeTracker(CODEX_CAPACITY_MESSAGE, capacityNoticeAboveComposer)

export const createCodexReconnectFailedNoticeTracker = (): CodexNoticeTracker =>
  new CodexNoticeTracker(CODEX_RECONNECT_FAILED_MESSAGE, reconnectFailedNoticeOnScreen)
