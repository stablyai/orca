import type { Terminal } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'
import { createTerminalAutosuggestLineTracker } from './terminal-autosuggest-line-tracker'

function makeFakeTerminal(lineText: string, cursorX: number, cursorY = 0, baseY = 0) {
  return {
    buffer: {
      active: {
        baseY,
        cursorX,
        cursorY,
        getLine: (row: number) => {
          if (row !== baseY + cursorY) {
            return undefined
          }
          return {
            translateToString: (_trimRight: boolean, start: number, end: number) =>
              lineText.slice(start, end)
          }
        }
      }
    }
  } as unknown as Terminal
}

/**
 * A fake terminal whose buffer state can be mutated after construction, so
 * tests can simulate the real sequence of events: prompt-end captures a
 * column/row snapshot, then the user types (mutating the line/cursor) before
 * getCurrentInputLine reads it back.
 */
function makeMutableFakeTerminal(initial: {
  lineText: string
  cursorX: number
  cursorY?: number
  baseY?: number
}) {
  const state = {
    lineText: initial.lineText,
    cursorX: initial.cursorX,
    cursorY: initial.cursorY ?? 0,
    baseY: initial.baseY ?? 0
  }
  const terminal = {
    buffer: {
      active: {
        get baseY() {
          return state.baseY
        },
        get cursorX() {
          return state.cursorX
        },
        get cursorY() {
          return state.cursorY
        },
        getLine: (row: number) => {
          if (row !== state.baseY + state.cursorY) {
            return undefined
          }
          return {
            translateToString: (_trimRight: boolean, start: number, end: number) =>
              state.lineText.slice(start, end)
          }
        }
      }
    }
  } as unknown as Terminal
  return { terminal, state }
}

describe('createTerminalAutosuggestLineTracker', () => {
  it('returns null before any prompt-end has been observed', () => {
    const tracker = createTerminalAutosuggestLineTracker(makeFakeTerminal('$ git st', 8))
    expect(tracker.getCurrentInputLine()).toBeNull()
  })

  it('captures the prompt-end column and reads the line up to the cursor', () => {
    const terminal = makeFakeTerminal('$ git st', 8)
    const tracker = createTerminalAutosuggestLineTracker(terminal)
    tracker.onPromptEndFact() // cursor is at col 2 ("$ " prompt) when ;B fires — simulate via a second fake
    // Re-simulate: prompt-end fires when cursor is right after "$ " (col 2); user has since typed up to col 8.
    // For this unit test we directly drive the two-phase capture:
    const promptOnlyTerminal = makeFakeTerminal('$ ', 2)
    const tracker2 = createTerminalAutosuggestLineTracker(promptOnlyTerminal)
    tracker2.onPromptEndFact()
    expect(tracker2.getCurrentInputLine()).toBe('')
  })

  it('resets to null when a command starts (Enter pressed)', () => {
    const terminal = makeFakeTerminal('$ ', 2)
    const tracker = createTerminalAutosuggestLineTracker(terminal)
    tracker.onPromptEndFact()
    tracker.onCommandStartedFact()
    expect(tracker.getCurrentInputLine()).toBeNull()
  })

  it('reads exactly the text typed since prompt-end as the buffer mutates', () => {
    const { terminal, state } = makeMutableFakeTerminal({ lineText: '$ ', cursorX: 2 })
    const tracker = createTerminalAutosuggestLineTracker(terminal)
    tracker.onPromptEndFact() // captures column 2 as the prompt boundary

    // User types "git st" — line and cursor advance, prompt text unaffected.
    state.lineText = '$ git st'
    state.cursorX = 8
    expect(tracker.getCurrentInputLine()).toBe('git st')

    // Further typing keeps slicing from the captured prompt column.
    state.lineText = '$ git status'
    state.cursorX = 12
    expect(tracker.getCurrentInputLine()).toBe('git status')
  })

  it('returns null once the buffer row no longer matches the row captured at prompt-end', () => {
    const { terminal, state } = makeMutableFakeTerminal({ lineText: '$ ', cursorX: 2 })
    const tracker = createTerminalAutosuggestLineTracker(terminal)
    tracker.onPromptEndFact()

    state.lineText = '$ git st'
    state.cursorX = 8
    expect(tracker.getCurrentInputLine()).toBe('git st')

    // Simulate a scroll / new line appearing: cursor moves to a different row.
    state.cursorY = 1
    expect(tracker.getCurrentInputLine()).toBeNull()
  })
})

describe('isCursorAtEndOfInputLine', () => {
  it('returns false before any prompt-end has been observed', () => {
    const tracker = createTerminalAutosuggestLineTracker(makeFakeTerminal('$ git st', 8))
    expect(tracker.isCursorAtEndOfInputLine()).toBe(false)
  })

  it('returns true when the cursor sits exactly at the end of the typed input', () => {
    const { terminal, state } = makeMutableFakeTerminal({ lineText: '$ ', cursorX: 2 })
    const tracker = createTerminalAutosuggestLineTracker(terminal)
    tracker.onPromptEndFact()
    state.lineText = '$ git status'
    state.cursorX = 12
    expect(tracker.isCursorAtEndOfInputLine()).toBe(true)
  })

  it('returns false when the cursor is mid-edit (typed text to the right of it)', () => {
    const { terminal, state } = makeMutableFakeTerminal({ lineText: '$ ', cursorX: 2 })
    const tracker = createTerminalAutosuggestLineTracker(terminal)
    tracker.onPromptEndFact()
    // Full input is "git status" (cols 2..12) but the cursor sits at col 8.
    state.lineText = '$ git status'
    state.cursorX = 8
    expect(tracker.isCursorAtEndOfInputLine()).toBe(false)
  })

  it('returns false when the cursor is further right than the typed input', () => {
    const { terminal, state } = makeMutableFakeTerminal({ lineText: '$ ', cursorX: 2 })
    const tracker = createTerminalAutosuggestLineTracker(terminal)
    tracker.onPromptEndFact()
    // Only "git" was typed (cols 2..5) but the cursor navigated to col 7.
    state.lineText = '$ git'
    state.cursorX = 7
    expect(tracker.isCursorAtEndOfInputLine()).toBe(false)
  })

  it('returns false once the buffer row no longer matches the captured row', () => {
    const { terminal, state } = makeMutableFakeTerminal({ lineText: '$ ', cursorX: 2 })
    const tracker = createTerminalAutosuggestLineTracker(terminal)
    tracker.onPromptEndFact()
    state.lineText = '$ git'
    state.cursorX = 5
    expect(tracker.isCursorAtEndOfInputLine()).toBe(true)
    state.cursorY = 1
    expect(tracker.isCursorAtEndOfInputLine()).toBe(false)
  })
})

describe('onChange', () => {
  it('notifies subscribers when prompt-end and command-started change tracked state', () => {
    const tracker = createTerminalAutosuggestLineTracker(makeFakeTerminal('$ ', 2))
    let calls = 0
    tracker.onChange(() => {
      calls += 1
    })
    tracker.onPromptEndFact()
    tracker.onCommandStartedFact()
    expect(calls).toBe(2)
  })

  it('stops notifying after the returned unsubscribe is called', () => {
    const tracker = createTerminalAutosuggestLineTracker(makeFakeTerminal('$ ', 2))
    let calls = 0
    const unsubscribe = tracker.onChange(() => {
      calls += 1
    })
    tracker.onPromptEndFact()
    unsubscribe()
    tracker.onCommandStartedFact()
    expect(calls).toBe(1)
  })
})
