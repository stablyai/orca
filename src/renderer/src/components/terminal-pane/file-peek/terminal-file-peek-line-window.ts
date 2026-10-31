import type { TerminalFilePeekContent } from './terminal-file-peek-content-types'

const WINDOW_LINES = 20
const LINE_CHARACTERS = 240

type LineWindowResult =
  | Omit<Extract<TerminalFilePeekContent, { kind: 'text' }>, 'path' | 'language'>
  | { kind: 'notice'; reason: 'line-out-of-range' }

export class TerminalFilePeekLineWindow {
  private readonly decoder = new TextDecoder()
  private readonly lines: { text: string; truncated: boolean }[] = []
  private line = ''
  private lineCharacters = 0
  private lineNumber = 0
  private carriageReturn = false
  private readonly lastWindowLine: number

  constructor(private readonly targetLine: number | null) {
    this.lastWindowLine = Math.max(1, (targetLine ?? 1) - WINDOW_LINES / 2) + WINDOW_LINES - 1
  }

  get complete(): boolean {
    return this.lineNumber >= this.lastWindowLine
  }

  push(bytes: Uint8Array): void {
    this.append(this.decoder.decode(bytes, { stream: true }))
  }

  finish(eof: boolean): LineWindowResult {
    if (!this.complete) {
      if (eof) {
        this.append(this.decoder.decode())
      }
      if (this.carriageReturn) {
        this.appendCharacter('\r')
      }
      if (eof || this.lineCharacters > 0) {
        this.finishLine()
      }
    }
    if (this.targetLine !== null && this.targetLine > this.lineNumber) {
      return { kind: 'notice', reason: 'line-out-of-range' }
    }
    return {
      kind: 'text',
      firstLineNumber: this.lineNumber - this.lines.length + 1,
      targetLine: this.targetLine,
      lines: this.lines.map((line) => line.text),
      truncatedLines: this.lines.some((line) => line.truncated)
    }
  }

  private append(source: string): void {
    for (const character of source) {
      if (this.complete) {
        break
      }
      if (character === '\n') {
        this.finishLine()
        this.carriageReturn = false
        continue
      }
      if (this.carriageReturn) {
        this.appendCharacter('\r')
      }
      this.carriageReturn = character === '\r'
      if (!this.carriageReturn) {
        this.appendCharacter(character)
      }
    }
  }

  private appendCharacter(character: string): void {
    if (this.lineCharacters < LINE_CHARACTERS) {
      this.line += character
    }
    this.lineCharacters += 1
  }

  private finishLine(): void {
    this.lines.push({ text: this.line, truncated: this.lineCharacters > LINE_CHARACTERS })
    if (this.lines.length > WINDOW_LINES) {
      this.lines.shift()
    }
    this.lineNumber += 1
    this.line = ''
    this.lineCharacters = 0
  }
}
