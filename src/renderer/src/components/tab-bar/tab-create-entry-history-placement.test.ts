import { describe, expect, it } from 'vitest'
import { placeHistoryRowsInEntryOptions } from './tab-create-entry-history-placement'
import type { BrowserHistoryOmniboxRow } from './tab-create-entry-active-option'
import type { TabEntryOption } from './tab-create-entry-action'
import type { ExistingFileMatch } from './tab-create-entry-file-matches'

function fileOption(
  relativePath: string,
  matchKind: ExistingFileMatch['matchKind']
): TabEntryOption {
  return {
    id: `existing-file:${relativePath}`,
    classification: { kind: 'existing-file', matchKind, relativePath }
  }
}

const searchOption: TabEntryOption = {
  id: 'search:readme',
  classification: { kind: 'search', engine: 'google', query: 'readme' }
}
const newFileOption: TabEntryOption = {
  id: 'new-file:readme',
  classification: { kind: 'new-file', relativePath: 'readme' }
}
const readmeHostOption: TabEntryOption = {
  id: 'host-url:https://readme.io/docs',
  classification: { kind: 'host-url', url: 'https://readme.io/docs' }
}
const exampleHostOption: TabEntryOption = {
  id: 'host-url:https://example.com',
  classification: { kind: 'host-url', url: 'https://example.com' }
}

function historyRow(url: string): BrowserHistoryOmniboxRow {
  return {
    id: `history:${url}`,
    entry: { url, normalizedUrl: url, title: 'Readme', lastVisitedAt: 1, visitCount: 1 }
  }
}

const rows = [historyRow('https://readme.io/docs')]

function kinds(options: readonly { kind: string }[]): string[] {
  return options.map((option) => option.kind)
}

describe('tab create entry history placement', () => {
  it('lands history below every file match and above new-file and search', () => {
    const placed = placeHistoryRowsInEntryOptions(
      [
        fileOption('README.md', 'exact-basename'),
        fileOption('docs/readme-notes.md', 'literal-basename'),
        newFileOption,
        searchOption
      ],
      rows
    )

    expect(kinds(placed)).toEqual(['entry', 'entry', 'history', 'entry', 'entry'])
    expect(placed[0]).toMatchObject({ option: { id: 'existing-file:README.md' } })
    expect(placed[1]).toMatchObject({ option: { id: 'existing-file:docs/readme-notes.md' } })
    expect(placed[3]).toMatchObject({ option: { id: 'new-file:readme' } })
  })

  it.each(['exact-path', 'exact-basename', 'literal-basename', 'fuzzy'] as const)(
    'stays below a lone %s file row',
    (matchKind) => {
      const placed = placeHistoryRowsInEntryOptions(
        [fileOption('docs/readme-notes.md', matchKind), searchOption],
        rows
      )

      expect(kinds(placed)).toEqual(['entry', 'history', 'entry'])
      expect(placed[0]).toMatchObject({ option: { id: 'existing-file:docs/readme-notes.md' } })
    }
  )

  // The phrase-query ordering: the classifier puts search first, and history
  // still has to end up under the fuzzy files that follow it.
  it('sinks past fuzzy files the classifier ranked below web search', () => {
    const placed = placeHistoryRowsInEntryOptions(
      [searchOption, fileOption('docs/readme-notes.md', 'fuzzy'), newFileOption],
      rows
    )

    expect(kinds(placed)).toEqual(['entry', 'entry', 'history', 'entry'])
    expect(placed[1]).toMatchObject({ option: { id: 'existing-file:docs/readme-notes.md' } })
  })

  it('leads the entry block when no file or typed url matched at all', () => {
    const placed = placeHistoryRowsInEntryOptions([searchOption, newFileOption], rows)

    expect(kinds(placed)).toEqual(['history', 'entry', 'entry'])
  })

  it('drops a typed-url row the history row already covers', () => {
    const placed = placeHistoryRowsInEntryOptions([readmeHostOption, searchOption], rows)

    expect(kinds(placed)).toEqual(['history', 'entry'])
    expect(placed[1]).toMatchObject({ option: { id: 'search:readme' } })
  })

  it('keeps a typed-url row that points somewhere else, and stays under it', () => {
    const placed = placeHistoryRowsInEntryOptions([exampleHostOption], rows)

    expect(kinds(placed)).toEqual(['entry', 'history'])
  })

  // Visiting a site must not change what Enter does on its name.
  it('takes the slot of a covered typed-url row above the files below it', () => {
    const placed = placeHistoryRowsInEntryOptions(
      [readmeHostOption, fileOption('docs/readme-notes.md', 'fuzzy')],
      rows
    )

    expect(kinds(placed)).toEqual(['history', 'entry'])
    expect(placed[1]).toMatchObject({ option: { id: 'existing-file:docs/readme-notes.md' } })
  })

  it('joins an uncovered typed-url row above the files below it', () => {
    const placed = placeHistoryRowsInEntryOptions(
      [exampleHostOption, fileOption('docs/readme-notes.md', 'fuzzy')],
      rows
    )

    expect(kinds(placed)).toEqual(['entry', 'history', 'entry'])
    expect(placed[0]).toMatchObject({ option: { id: 'host-url:https://example.com' } })
  })

  it.each([
    { relation: 'replaces', url: readmeHostOption, expected: ['entry', 'history', 'entry'] },
    { relation: 'joins', url: exampleHostOption, expected: ['entry', 'entry', 'history', 'entry'] }
  ])('keeps exact files above history that $relation the typed-url row', ({ url, expected }) => {
    const placed = placeHistoryRowsInEntryOptions(
      [
        fileOption('README.md', 'exact-basename'),
        url,
        fileOption('docs/readme-notes.md', 'literal-basename')
      ],
      rows
    )

    expect(kinds(placed)).toEqual(expected)
    expect(placed[0]).toMatchObject({ option: { id: 'existing-file:README.md' } })
    expect(placed.at(-1)).toMatchObject({ option: { id: 'existing-file:docs/readme-notes.md' } })
  })

  it('skips status rows, which are not actionable options', () => {
    const placed = placeHistoryRowsInEntryOptions(
      [{ id: 'loading', classification: { kind: 'blocked', message: 'Loading files...' } }],
      rows
    )

    expect(kinds(placed)).toEqual(['history'])
  })

  it('returns only the mapped entry rows when there is no history to insert', () => {
    const placed = placeHistoryRowsInEntryOptions([searchOption], [])

    expect(kinds(placed)).toEqual(['entry'])
  })
})
