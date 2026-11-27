// @vitest-environment happy-dom
import { act, cleanup } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { SearchResult } from '../../../../../../shared/file-search/code-search-types'
import { getInitialSearchDraft } from './use-search-draft-lifecycle'
import { useCombinedSearch } from './useCombinedSearch'

const initial = useAppStore.getState()
/** Text scans the field started, in order, each resolvable by the test. */
export const pending: { query: string; resolve: (result: SearchResult) => void }[] = []
export const cancelSearch = vi.fn(async () => undefined)
const noop = (): void => {}

export function resultFor(query: string): SearchResult {
  return {
    totalMatches: 1,
    truncated: false,
    files: [
      {
        filePath: `/repo/${query}.ts`,
        relativePath: `${query}.ts`,
        matches: [{ line: 1, column: 1, matchLength: query.length, lineContent: query }]
      }
    ]
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  pending.length = 0
  cancelSearch.mockClear()
  Object.assign(window, {
    api: {
      ...window.api,
      fs: {
        search: (options: { query: string }) =>
          new Promise<SearchResult>((resolve) => pending.push({ query: options.query, resolve })),
        cancelSearch
      }
    }
  })
})

afterEach(() => {
  cleanup()
  mounted.field = null
  mounted.renders = []
  mounted.announcements = []
  vi.useRealTimers()
  useAppStore.setState(initial, true)
})

type FieldState = ReturnType<typeof useCombinedSearch>
export const mounted: { field: FieldState | null; renders: string[]; announcements: string[] } = {
  field: null,
  renders: [],
  announcements: []
}

/** The search field as the Files pane mounts it: keyed per worktree, opening on its initial draft. */
export function FieldHost({
  worktreeId,
  worktreePath = '/repo',
  namesLoading = false
}: {
  worktreeId: string
  worktreePath?: string | null
  namesLoading?: boolean
}): null {
  const [start] = useState(() => getInitialSearchDraft(worktreeId))
  const [query, setQuery] = useState(start.text)
  mounted.field = useCombinedSearch({
    activeWorktreeId: worktreeId,
    worktreePath,
    query,
    setQuery,
    nameMatches: query.trim() && !namesLoading ? { total: 0, matches: [] } : null,
    namesLoading,
    namesError: null,
    onOpenName: noop,
    onShowAllNames: noop,
    initial: start
  })
  const { model } = mounted.field.results
  mounted.renders.push(Array.from({ length: model.count }, (_, i) => model.getKey(i)).join(','))
  mounted.announcements.push(mounted.field.announcement)
  return null
}

export function field(): FieldState {
  if (!mounted.field) {
    throw new Error('field not mounted')
  }
  return mounted.field
}

export async function advanceFakeClock(ms = 300): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
}
