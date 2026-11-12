import type { IBuffer, IMarker } from '@xterm/xterm'
import { closesAppOsc133Zone } from '../../../../../../shared/terminal/output/terminal-osc133-command-finished'
import { stripTerminalSelectionGutter } from '../../../../../../shared/terminal/output/terminal-selection-gutter'
import {
  readTerminalCommandBlockText,
  type TerminalBlockLineReader,
  type TerminalCommandBlockLines,
  type TerminalCommandBlockPart
} from './terminal-command-block-text'

/** Structural minimum for block tracking; satisfied by @xterm/xterm and @xterm/headless terminals. */
export type CommandBlockTerminal = {
  readonly buffer: { readonly active: IBuffer }
  readonly parser: {
    registerOscHandler: (
      ident: number,
      callback: (data: string) => boolean
    ) => { dispose: () => void }
  }
  readonly registerMarker?: (cursorYOffset?: number) => IMarker | undefined
  readonly onResize?: (callback: () => void) => { dispose: () => void }
}

export type TerminalCommandBlockTextOptions = {
  /** Mirror the terminalCopyTrimsGutter setting; the caller reads it. */
  trimGutter: boolean
}

const MAX_TRACKED_BLOCKS = 50

export type TrackedCommandBlock = {
  promptMarker: IMarker
  outputStartMarker: IMarker
  outputEndMarker: IMarker
  /** Command-input start (B position); null when the shell emitted no B. */
  inputStartMarker: IMarker | null
  inputStartCol: number
  /**
   * True when the D row itself held trailing output (no trailing newline), so
   * the exclusive end is the row below the end marker instead of the marker row.
   */
  outputEndExtraRow: boolean
  /** D-row text snapshotted at D time; the next prompt may repaint that row. */
  outputEndRowSnapshot: { text: string; wrapped: boolean } | null
  /** True once a later prompt repainted the D row; the block no longer owns it. */
  outputEndRowRepainted: boolean
  exitCode: number | null
}

export type TerminalCommandBlockTracker = {
  handleOsc133Payload: (payload: string) => void
  resolveBlockAtRow: (row: number) => TrackedCommandBlock | null
  dispose: () => void
}

function parseOsc133Sequence(payload: string): { letter: string; exitCode: number | null } {
  const [sequence, exitCode] = payload.split(';')
  const parsed = exitCode === undefined || exitCode === '' ? null : Number.parseInt(exitCode, 10)
  return {
    letter: sequence.slice(0, 1),
    exitCode: parsed === null || Number.isNaN(parsed) ? null : parsed
  }
}

function blockLines(block: TrackedCommandBlock): TerminalCommandBlockLines | null {
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

function disposeBlock(block: TrackedCommandBlock): void {
  block.promptMarker.dispose()
  block.outputStartMarker.dispose()
  block.outputEndMarker.dispose()
  block.inputStartMarker?.dispose()
}

function absoluteCursorRow(buffer: IBuffer): number {
  return buffer.baseY + buffer.cursorY
}

export function createTerminalCommandBlockTracker(
  terminal: CommandBlockTerminal
): TerminalCommandBlockTracker {
  const blocks: TrackedCommandBlock[] = []
  let pendingPrompt: IMarker | null = null
  let pendingOutputStart: IMarker | null = null
  let pendingInputStart: { marker: IMarker; col: number } | null = null
  let adjacentMarkers = ''
  let lastPayloadCursor: { x: number; row: number } | null = null

  const registerCurrentLine = (): IMarker | null => {
    const buffer = terminal.buffer.active
    if (buffer.type !== 'normal') {
      return null
    }
    return terminal.registerMarker?.(0) ?? null
  }

  const clearPending = (): void => {
    pendingPrompt?.dispose()
    pendingOutputStart?.dispose()
    pendingInputStart?.marker.dispose()
    pendingPrompt = null
    pendingOutputStart = null
    pendingInputStart = null
  }

  const prune = (): void => {
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      if (blockLines(blocks[index]) === null) {
        const [removed] = blocks.splice(index, 1)
        disposeBlock(removed)
      }
    }
    while (blocks.length > MAX_TRACKED_BLOCKS) {
      const removed = blocks.shift()
      if (removed) {
        disposeBlock(removed)
      }
    }
  }

  const dropAllBlocks = (): void => {
    clearPending()
    for (const block of blocks.splice(0)) {
      disposeBlock(block)
    }
  }

  // Markers don't survive reflow (rows split/join under them), so any resize
  // invalidates attribution. Re-registering from scratch is the only sound move.
  const resizeSubscription = terminal.onResize?.(() => {
    dropAllBlocks()
  })

  return {
    handleOsc133Payload(payload: string): void {
      // Known limitation: a command that enters a fullscreen app (C in the
      // normal buffer, D after exit) keeps stale row attribution; Copy Output
      // then reads whatever those normal-buffer rows hold. Fixing that needs
      // a buffer-switch observer the tracker deliberately lacks.
      const buffer = terminal.buffer.active
      if (buffer.type !== 'normal') {
        return
      }
      const { letter, exitCode } = parseOsc133Sequence(payload)
      // OMP closes its own zones with adjacent B C D;0. The cursor cannot move
      // without output between two sequences, so an unmoved cursor proves the
      // same adjacency the byte-path scanner tracks with noteOutput().
      const cursor = { x: buffer.cursorX, row: absoluteCursorRow(buffer) }
      const adjacent =
        lastPayloadCursor !== null &&
        lastPayloadCursor.x === cursor.x &&
        lastPayloadCursor.row === cursor.row
      // The markers are read before this payload updates them, so a stale BC
      // plus cursor-moving output would still match; the current adjacency
      // proves no output landed between C and D, like the byte-path scanner.
      const closesAppZone = adjacent && closesAppOsc133Zone(adjacentMarkers, payload)
      adjacentMarkers = adjacent ? (adjacentMarkers + letter).slice(-2) : letter
      lastPayloadCursor = cursor
      if (closesAppZone) {
        // The zone's C already set pending output start on this row; roll it
        // back along with any same-row input start so the real command keeps
        // clean boundaries (full-row fallback beats a wrong slice).
        if (pendingOutputStart && pendingOutputStart.line === cursor.row) {
          pendingOutputStart.dispose()
          pendingOutputStart = null
        }
        if (pendingInputStart && pendingInputStart.marker.line === cursor.row) {
          pendingInputStart.marker.dispose()
          pendingInputStart = null
        }
        return
      }
      // Line attribution assumes shell timing: A arrives with the prompt, B at
      // the end of the prompt where input starts, C after the echo newline
      // where output begins, D on the first line past the output. Fish and
      // foreign SSH shells emit no 133, so no blocks.
      if (letter === 'A') {
        clearPending()
        // A prompt starting on a no-trailing-newline D row takes that row
        // over; the old block keeps its snapshotted output but loses the row.
        for (const block of blocks) {
          if (block.outputEndExtraRow && block.outputEndMarker.line === cursor.row) {
            block.outputEndRowRepainted = true
          }
        }
        pendingPrompt = registerCurrentLine()
      } else if (letter === 'B') {
        if (pendingPrompt && !pendingInputStart) {
          const marker = registerCurrentLine()
          if (marker) {
            pendingInputStart = { marker, col: buffer.cursorX }
          }
        }
      } else if (letter === 'C') {
        if (pendingPrompt && !pendingOutputStart) {
          pendingOutputStart = registerCurrentLine()
        }
      } else if (letter === 'D') {
        if (!pendingPrompt || !pendingOutputStart) {
          clearPending()
          return
        }
        if (
          pendingPrompt.isDisposed ||
          pendingOutputStart.isDisposed ||
          (pendingInputStart && pendingInputStart.marker.isDisposed)
        ) {
          clearPending()
          return
        }
        const outputEnd = registerCurrentLine()
        if (!outputEnd) {
          clearPending()
          return
        }
        // Without a trailing newline the D row itself holds output text; the
        // next prompt will repaint it, so snapshot now.
        const endRow = buffer.getLine(absoluteCursorRow(buffer))
        const endRowText = endRow?.translateToString(true) ?? ''
        const hasTrailingOutput = endRowText.trim() !== ''
        blocks.push({
          promptMarker: pendingPrompt,
          outputStartMarker: pendingOutputStart,
          outputEndMarker: outputEnd,
          inputStartMarker: pendingInputStart?.marker ?? null,
          inputStartCol: pendingInputStart?.col ?? 0,
          outputEndExtraRow: hasTrailingOutput,
          outputEndRowSnapshot: hasTrailingOutput
            ? { text: endRowText, wrapped: endRow?.isWrapped ?? false }
            : null,
          outputEndRowRepainted: false,
          exitCode
        })
        pendingPrompt = null
        pendingOutputStart = null
        pendingInputStart = null
        prune()
      }
    },

    resolveBlockAtRow(row: number): TrackedCommandBlock | null {
      if (terminal.buffer.active.type !== 'normal') {
        return null
      }
      prune()
      for (let index = blocks.length - 1; index >= 0; index -= 1) {
        const lines = blockLines(blocks[index])
        if (!lines) {
          continue
        }
        const endLine = lines.outputEndLine - (blocks[index].outputEndRowRepainted ? 1 : 0)
        if (lines.promptLine <= row && row < endLine) {
          return blocks[index]
        }
      }
      return null
    },

    dispose(): void {
      resizeSubscription?.dispose()
      clearPending()
      for (const block of blocks.splice(0)) {
        disposeBlock(block)
      }
      adjacentMarkers = ''
      lastPayloadCursor = null
    }
  }
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
  const lines = blockLines(block)
  if (!lines) {
    return null
  }
  const reader: TerminalBlockLineReader = {
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
  // The gutter strip applies to output rows only: command rows start with the
  // prompt, so including them would under-strip shared leading spaces.
  const output = readTerminalCommandBlockText(reader, lines, 'output')
  const trimmedOutput = options.trimGutter ? stripTerminalSelectionGutter(output) : output
  if (part === 'output') {
    return trimmedOutput
  }
  const command = readTerminalCommandBlockText(reader, lines, 'command')
  if (part === 'command') {
    return command
  }
  return trimmedOutput ? `${command}\n${trimmedOutput}` : command
}
