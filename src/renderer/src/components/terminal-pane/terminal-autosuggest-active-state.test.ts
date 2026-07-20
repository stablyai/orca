import type { Terminal } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'
import { computeActiveAutosuggestState } from './terminal-autosuggest-active-state'
import type { TerminalAutosuggestLineTracker } from './terminal-autosuggest-line-tracker'

function makeTerminal(options: {
  cursorX?: number
  cursorY?: number
  baseY?: number
  bracketedPasteMode?: boolean
}): Terminal {
  return {
    modes: { bracketedPasteMode: options.bracketedPasteMode ?? false },
    buffer: {
      active: {
        baseY: options.baseY ?? 0,
        cursorX: options.cursorX ?? 8,
        cursorY: options.cursorY ?? 0
      }
    }
  } as unknown as Terminal
}

function makeTracker(
  overrides: Partial<Pick<TerminalAutosuggestLineTracker, 'getCurrentInputLine' | 'isCursorAtEndOfInputLine'>>
): Pick<TerminalAutosuggestLineTracker, 'getCurrentInputLine' | 'isCursorAtEndOfInputLine'> {
  return {
    getCurrentInputLine: () => 'git s',
    isCursorAtEndOfInputLine: () => true,
    ...overrides
  }
}

describe('computeActiveAutosuggestState', () => {
  it('returns a populated result on the happy path', () => {
    const terminal = makeTerminal({ cursorX: 7, cursorY: 2, baseY: 100 })
    const result = computeActiveAutosuggestState(
      terminal,
      makeTracker({}),
      ['git status', 'ls'],
      '#abcdef'
    )
    expect(result).toEqual({
      terminal,
      row: 102,
      cursorCol: 7,
      remainder: 'tatus',
      foregroundColor: '#abcdef'
    })
  })

  it('returns null while bracketed paste mode is active', () => {
    const terminal = makeTerminal({ bracketedPasteMode: true })
    expect(
      computeActiveAutosuggestState(terminal, makeTracker({}), ['git status'], '#fff')
    ).toBeNull()
  })

  it('returns null when the cursor is not at end-of-line', () => {
    const terminal = makeTerminal({})
    expect(
      computeActiveAutosuggestState(
        terminal,
        makeTracker({ isCursorAtEndOfInputLine: () => false }),
        ['git status'],
        '#fff'
      )
    ).toBeNull()
  })

  it('returns null when there is no tracked input line', () => {
    const terminal = makeTerminal({})
    expect(
      computeActiveAutosuggestState(
        terminal,
        makeTracker({ getCurrentInputLine: () => null }),
        ['git status'],
        '#fff'
      )
    ).toBeNull()
  })

  it('returns null when no candidate matches the current input', () => {
    const terminal = makeTerminal({})
    expect(
      computeActiveAutosuggestState(terminal, makeTracker({}), ['npm run build'], '#fff')
    ).toBeNull()
  })
})
