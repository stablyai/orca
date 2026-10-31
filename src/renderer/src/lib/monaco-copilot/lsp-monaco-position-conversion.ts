import type { IRange } from 'monaco-editor'

export type LspPosition = { line: number; character: number }
export type LspRange = { start: LspPosition; end: LspPosition }

/** Monaco positions are 1-based; LSP positions are 0-based. */
export function toLspPosition(position: { lineNumber: number; column: number }): LspPosition {
  return { line: position.lineNumber - 1, character: position.column - 1 }
}

export function lspRangeToMonaco(range: LspRange): IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1
  }
}
