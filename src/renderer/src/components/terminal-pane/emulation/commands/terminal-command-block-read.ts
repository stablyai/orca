import { stripTerminalSelectionGutter } from '../../../../../../shared/terminal/output/terminal-selection-gutter'
import {
  readTerminalCommandBlockText,
  type TerminalBlockLineReader,
  type TerminalCommandBlockLines,
  type TerminalCommandBlockPart
} from './terminal-command-block-text'
import type { CommandBlockTerminal, TrackedCommandBlock } from './terminal-command-block-tracker'

export type TerminalCommandBlockTextOptions = {
  /** Mirror the terminalCopyTrimsGutter setting; the caller reads it. */
  trimGutter: boolean
}

export function terminalCommandBlockLines(
  block: TrackedCommandBlock
): TerminalCommandBlockLines | null {
  if (
    block.promptMarker.isDisposed ||
    block.outputStartMarker.isDisposed ||
    block.outputEndMarker.isDisposed
  ) {
    return null
  }
  const promptLine = block.promptMarker.line
  return {
    promptLine,
    outputStartLine: block.outputStartMarker.line,
    outputEndLine: block.outputEndMarker.line + (block.outputEndExtraRow ? 1 : 0),
    inputStart:
      block.inputStartMarker && !block.inputStartMarker.isDisposed
        ? { row: block.inputStartMarker.line, col: block.inputStartCol }
        : null,
    outputEndRowSnapshot: block.outputEndExtraRow ? block.outputEndRowSnapshot : null
  }
}

export function createTerminalBlockLineReader(
  terminal: CommandBlockTerminal
): TerminalBlockLineReader {
  return {
    getLine: (row: number) => {
      const line = terminal.buffer.active.getLine(row)
      if (!line) {
        return null
      }
      return { text: line.translateToString(true), wrapped: line.isWrapped }
    },
    sliceLineFromCol: (row: number, col: number) => {
      const line = terminal.buffer.active.getLine(row)
      if (!line) {
        return null
      }
      // Walk cells, not string units: wide glyphs span two cells and joined
      // marks share one. Measuring the live line keeps this exact under any
      // Unicode provider version instead of mirroring a width table.
      let index = 0
      for (let x = 0; x < col; x += 1) {
        const cell = line.getCell(x)
        if (!cell) {
          break
        }
        if (cell.getWidth() !== 0) {
          index += cell.getChars().length
        }
      }
      return line.translateToString(true).slice(index)
    }
  }
}

/**
 * Snapshot the command text while the prompt rows are guaranteed alive. After
 * C, output only appends below, so this equals any later buffer read until
 * the rows scroll out; the snapshot then outlives them for output-only blocks.
 */
export function snapshotBlockCommandText(
  terminal: CommandBlockTerminal,
  promptLine: number,
  outputStartLine: number,
  inputStart: { row: number; col: number } | null
): string {
  const lines: TerminalCommandBlockLines = {
    promptLine,
    outputStartLine,
    outputEndLine: outputStartLine,
    inputStart,
    outputEndRowSnapshot: null
  }
  return readTerminalCommandBlockText(createTerminalBlockLineReader(terminal), lines, 'command')
}

export function isTerminalCommandBlockAlive(block: TrackedCommandBlock): boolean {
  return (
    !block.promptMarker.isDisposed &&
    !block.outputStartMarker.isDisposed &&
    !block.outputEndMarker.isDisposed
  )
}

/**
 * Pick the block a menu copy action may use. The captured block's markers
 * follow scrollback trims, so it stays correct when the stale click row
 * resolves elsewhere; a repainted block whose resolution moved on is
 * distrusted instead, since the click row may show a new prompt.
 */
export function selectMenuCommandBlockForCopy(
  captured: TrackedCommandBlock | null,
  current: TrackedCommandBlock | null
): TrackedCommandBlock | null {
  if (!captured || !isTerminalCommandBlockAlive(captured)) {
    return null
  }
  if (current === captured) {
    return captured
  }
  if (captured.outputEndRowRepainted) {
    return null
  }
  return captured
}

export function readTerminalBlockTextFromTerminal(
  terminal: CommandBlockTerminal,
  block: TrackedCommandBlock,
  part: TerminalCommandBlockPart,
  options: TerminalCommandBlockTextOptions
): string | null {
  if (terminal.buffer.active.type !== 'normal') {
    return null
  }
  const lines = terminalCommandBlockLines(block)
  if (!lines) {
    return null
  }
  const reader = createTerminalBlockLineReader(terminal)
  // The gutter strip applies to output rows only: command rows start with the
  // prompt, so including them would under-strip shared leading spaces.
  const output = readTerminalCommandBlockText(reader, lines, 'output')
  const trimmedOutput = options.trimGutter ? stripTerminalSelectionGutter(output) : output
  if (part === 'output') {
    return trimmedOutput
  }
  const command = block.commandSnapshot ?? readTerminalCommandBlockText(reader, lines, 'command')
  if (part === 'command') {
    return command
  }
  return trimmedOutput ? `${command}\n${trimmedOutput}` : command
}
