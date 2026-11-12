import type { IBuffer, IMarker } from '@xterm/xterm'
import { closesAppOsc133Zone } from '../../../../../../shared/terminal/output/terminal-osc133-command-finished'
import { snapshotBlockCommandText, terminalCommandBlockLines } from './terminal-command-block-read'

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

const MIN_TRACKED_BLOCKS = 50

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
  /** Command text snapshotted at C time; set when the prompt rows are already gone at D. */
  commandSnapshot: string | null
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

function disposeBlock(block: TrackedCommandBlock): void {
  // Output-only blocks share one marker as prompt and output start.
  const markers = new Set([block.promptMarker, block.outputStartMarker, block.outputEndMarker])
  if (block.inputStartMarker) {
    markers.add(block.inputStartMarker)
  }
  for (const marker of markers) {
    marker.dispose()
  }
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
  let pendingCommandSnapshot: string | null = null
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
    pendingCommandSnapshot = null
  }

  // Retention follows the buffer: blocks die with their rows, and the count
  // cap scales with retained rows so visible blocks are never evicted.
  const prune = (): void => {
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      if (terminalCommandBlockLines(blocks[index]) === null) {
        const [removed] = blocks.splice(index, 1)
        disposeBlock(removed)
      }
    }
    const maxBlocks = Math.max(MIN_TRACKED_BLOCKS, terminal.buffer.active.length)
    while (blocks.length > maxBlocks) {
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
          pendingCommandSnapshot = null
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
          // Prompt rows never change after C until they scroll out, so this
          // snapshot equals any later buffer read and outlives the rows.
          pendingCommandSnapshot = snapshotBlockCommandText(
            terminal,
            pendingPrompt.line,
            absoluteCursorRow(buffer),
            pendingInputStart && !pendingInputStart.marker.isDisposed
              ? { row: pendingInputStart.marker.line, col: pendingInputStart.col }
              : null
          )
        }
      } else if (letter === 'D') {
        if (!pendingOutputStart || pendingOutputStart.isDisposed) {
          clearPending()
          return
        }
        const promptAlive = !!pendingPrompt && !pendingPrompt.isDisposed
        if (!promptAlive && pendingCommandSnapshot === null) {
          clearPending()
          return
        }
        const outputEnd = registerCurrentLine()
        if (!outputEnd) {
          clearPending()
          return
        }
        // Output longer than the scrollback evicts the prompt rows before D;
        // anchor the range at the surviving output start instead of dropping
        // the visible output, with the command text from the C snapshot.
        let promptMarker: IMarker
        let commandSnapshot: string | null = null
        if (pendingPrompt && !pendingPrompt.isDisposed) {
          promptMarker = pendingPrompt
        } else {
          pendingPrompt?.dispose()
          promptMarker = pendingOutputStart
          commandSnapshot = pendingCommandSnapshot
        }
        // Without a trailing newline the D row itself holds output text; the
        // next prompt will repaint it, so snapshot now.
        const endRow = buffer.getLine(absoluteCursorRow(buffer))
        const endRowText = endRow?.translateToString(true) ?? ''
        const hasTrailingOutput = endRowText.trim() !== ''
        let inputStartMarker: IMarker | null = null
        if (pendingInputStart) {
          if (pendingInputStart.marker.isDisposed) {
            pendingInputStart.marker.dispose()
          } else {
            inputStartMarker = pendingInputStart.marker
          }
        }
        blocks.push({
          promptMarker,
          outputStartMarker: pendingOutputStart,
          outputEndMarker: outputEnd,
          inputStartMarker,
          inputStartCol: pendingInputStart?.col ?? 0,
          outputEndExtraRow: hasTrailingOutput,
          outputEndRowSnapshot: hasTrailingOutput
            ? { text: endRowText, wrapped: endRow?.isWrapped ?? false }
            : null,
          outputEndRowRepainted: false,
          commandSnapshot,
          exitCode
        })
        pendingPrompt = null
        pendingOutputStart = null
        pendingInputStart = null
        pendingCommandSnapshot = null
        prune()
      }
    },

    resolveBlockAtRow(row: number): TrackedCommandBlock | null {
      if (terminal.buffer.active.type !== 'normal') {
        return null
      }
      prune()
      for (let index = blocks.length - 1; index >= 0; index -= 1) {
        const lines = terminalCommandBlockLines(blocks[index])
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
