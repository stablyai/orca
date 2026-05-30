import type { IPosition, IRange } from 'monaco-editor'
import { describe, expect, it, vi } from 'vitest'
import { getMonacoCodebaseSearchQuery } from './monaco-codebase-search'

type FakeSelection = IRange & {
  isEmpty: () => boolean
}

function selection(empty: boolean): FakeSelection {
  return {
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: 1,
    endColumn: 1,
    isEmpty: () => empty
  }
}

function position(): IPosition {
  return { lineNumber: 1, column: 5 }
}

function model(args: { selectedText?: string; word?: string }) {
  return {
    getValueInRange: vi.fn((_range: IRange) => args.selectedText ?? ''),
    getWordAtPosition: vi.fn((_position: IPosition) =>
      args.word === undefined ? null : { word: args.word }
    )
  }
}

describe('getMonacoCodebaseSearchQuery', () => {
  it('prefers normalized selected text over the cursor word', () => {
    const fakeModel = model({ selectedText: '  foo\r\n  bar  ', word: 'fallback' })

    expect(getMonacoCodebaseSearchQuery(fakeModel, selection(false), position())).toBe('foo bar')
    expect(fakeModel.getWordAtPosition).not.toHaveBeenCalled()
  })

  it('falls back to the cursor word when there is no selection', () => {
    expect(
      getMonacoCodebaseSearchQuery(model({ word: 'needle' }), selection(true), position())
    ).toBe('needle')
  })

  it('falls back to the cursor word when the selection normalizes to empty', () => {
    expect(
      getMonacoCodebaseSearchQuery(
        model({ selectedText: ' \n\t ', word: 'cursorWord' }),
        selection(false),
        position()
      )
    ).toBe('cursorWord')
  })

  it('returns null when neither selection nor cursor word yields a query', () => {
    expect(getMonacoCodebaseSearchQuery(model({}), selection(true), position())).toBeNull()
    expect(getMonacoCodebaseSearchQuery(null, selection(true), position())).toBeNull()
  })
})
