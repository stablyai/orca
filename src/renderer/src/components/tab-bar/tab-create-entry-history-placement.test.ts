import { describe, expect, it } from 'vitest'
import { insertHistoryRowsBelowFileMatches } from './tab-create-entry-history-placement'
import type { BrowserHistoryOmniboxRow } from './tab-create-entry-active-option'
import type { TabEntryOption } from './tab-create-entry-action'

function fileOption(
  relativePath: string,
  matchKind: 'exact-path' | 'exact-basename' | 'fuzzy'
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
    const placed = insertHistoryRowsBelowFileMatches(
      [
        fileOption('README.md', 'exact-basename'),
        fileOption('docs/readme-notes.md', 'fuzzy'),
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

  it('stays below a fuzzy match that is the only file row', () => {
    const placed = insertHistoryRowsBelowFileMatches(
      [fileOption('docs/readme-notes.md', 'fuzzy'), searchOption],
      rows
    )

    expect(kinds(placed)).toEqual(['entry', 'history', 'entry'])
    expect(placed[0]).toMatchObject({ option: { id: 'existing-file:docs/readme-notes.md' } })
  })

  // The phrase-query ordering: the classifier puts search first, and history
  // still has to end up under the fuzzy files that follow it.
  it('sinks past fuzzy files the classifier ranked below web search', () => {
    const placed = insertHistoryRowsBelowFileMatches(
      [searchOption, fileOption('docs/readme-notes.md', 'fuzzy'), newFileOption],
      rows
    )

    expect(kinds(placed)).toEqual(['entry', 'entry', 'history', 'entry'])
    expect(placed[1]).toMatchObject({ option: { id: 'existing-file:docs/readme-notes.md' } })
  })

  it('leads the entry block when no file or typed url matched at all', () => {
    const placed = insertHistoryRowsBelowFileMatches([searchOption, newFileOption], rows)

    expect(kinds(placed)).toEqual(['history', 'entry', 'entry'])
  })

  it('drops a typed-url row the history row already covers', () => {
    const placed = insertHistoryRowsBelowFileMatches(
      [
        {
          id: 'host-url:https://readme.io/docs',
          classification: { kind: 'host-url', url: 'https://readme.io/docs' }
        },
        searchOption
      ],
      rows
    )

    expect(kinds(placed)).toEqual(['history', 'entry'])
    expect(placed[1]).toMatchObject({ option: { id: 'search:readme' } })
  })

  it('keeps a typed-url row that points somewhere else, and stays under it', () => {
    const placed = insertHistoryRowsBelowFileMatches(
      [
        {
          id: 'host-url:https://example.com',
          classification: { kind: 'host-url', url: 'https://example.com' }
        }
      ],
      rows
    )

    expect(kinds(placed)).toEqual(['entry', 'history'])
  })

  it('skips status rows, which are not actionable options', () => {
    const placed = insertHistoryRowsBelowFileMatches(
      [{ id: 'loading', classification: { kind: 'blocked', message: 'Loading files...' } }],
      rows
    )

    expect(kinds(placed)).toEqual(['history'])
  })

  it('returns only the mapped entry rows when there is no history to insert', () => {
    const placed = insertHistoryRowsBelowFileMatches([searchOption], [])

    expect(kinds(placed)).toEqual(['entry'])
  })
})
