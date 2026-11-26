// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { FileSearchResultOwner } from '@/lib/files/search/file-search-result-owner'
import type { FileSearchWorktreeState } from '@/store/slices/editor/types/file-search-worktree-state'
import type { SearchResult } from '../../../../../../shared/file-search/code-search-types'
import { useCombinedTextResults } from './use-combined-text-results'

afterEach(cleanup)

const ownerA: FileSearchResultOwner = { worktreeId: 'wt', runtimeEnvironmentId: null }
const ownerB: FileSearchResultOwner = { worktreeId: 'wt', runtimeEnvironmentId: 'env-b' }

function result(path: string): SearchResult {
  return {
    totalMatches: 1,
    truncated: false,
    files: [
      {
        filePath: `/repo/${path}`,
        relativePath: path,
        matches: [{ line: 1, column: 1, matchLength: 4, lineContent: 'cart' }]
      }
    ]
  }
}

function state(results: SearchResult, resultOwner: FileSearchResultOwner): FileSearchWorktreeState {
  return {
    query: 'cart',
    caseSensitive: false,
    wholeWord: false,
    useRegex: false,
    includePattern: '',
    excludePattern: '',
    results,
    resultOwner,
    loading: false,
    collapsedFiles: new Set()
  }
}

describe('combined text results generation', () => {
  it('never admits a deferred payload from the previous owner for the same query', () => {
    const seen: { live: boolean; owner: FileSearchResultOwner | null }[] = []
    const { rerender } = renderHook(
      ({ searchState, liveOwner }) => {
        const text = useCombinedTextResults({
          query: 'cart',
          forcedShortQuery: null,
          searchState,
          collapsedFiles: new Set(),
          isCurrentOwner: (owner) => owner === liveOwner
        })
        seen.push({ live: text.deferredIsLive, owner: text.deferredResults.owner })
        return text
      },
      { initialProps: { searchState: state(result('a.ts'), ownerA), liveOwner: ownerA } }
    )
    expect(seen.at(-1)).toEqual({ live: true, owner: ownerA })
    const before = seen.length

    act(() => rerender({ searchState: state(result('b.ts'), ownerB), liveOwner: ownerB }))
    // The owner changed under the same query: a render still holding owner A's payload must not show it.
    const afterSwap = seen.slice(before)
    expect(afterSwap.length).toBeGreaterThan(1)
    expect(afterSwap.filter((render) => render.live && render.owner !== ownerB)).toEqual([])
    expect(seen.at(-1)).toEqual({ live: true, owner: ownerB })
  })
})
