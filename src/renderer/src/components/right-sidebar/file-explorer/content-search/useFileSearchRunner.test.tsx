// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SearchResult } from '../../../../../../shared/code-search-types'
import { useFileSearchRunner } from './useFileSearchRunner'

const mocks = vi.hoisted(() => ({
  getConnectionId: vi.fn(),
  getState: vi.fn(),
  searchRuntimeFiles: vi.fn()
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: mocks.getConnectionId
}))

vi.mock('@/runtime/files/search/runtime-file-search-client', () => ({
  searchRuntimeFiles: mocks.searchRuntimeFiles
}))

vi.mock('@/store/index', () => ({
  useAppStore: Object.assign(
    vi.fn((selector: (state: ReturnType<typeof mocks.getState>) => unknown) =>
      selector(mocks.getState())
    ),
    { getState: mocks.getState }
  )
}))

const RESULTS: SearchResult = {
  files: [],
  totalMatches: 0,
  truncated: false
}

function renderSearchRunner(state: Record<string, unknown>, worktreeId: string) {
  const updates: Record<string, unknown>[] = []
  mocks.getState.mockImplementation(() => state)
  mocks.searchRuntimeFiles.mockResolvedValue(RESULTS)

  const hook = renderHook(() =>
    useFileSearchRunner({
      activeWorktreeId: worktreeId,
      worktreePath: '/repo',
      updateActiveSearchState: (update) => updates.push(update)
    })
  )

  return { hook, updates }
}

async function finishSearch(executeSearch: (query: string) => void): Promise<void> {
  await act(async () => {
    executeSearch('owner')
    await vi.advanceTimersByTimeAsync(300)
  })
}

describe('useFileSearchRunner result ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.getConnectionId.mockReturnValue(null)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('ignores an older rejection after a newer search has succeeded', async () => {
    const { hook, updates } = renderSearchRunner(
      { settings: {}, repos: [], worktreesByRepo: {}, fileSearchStateByWorktree: {} },
      'missing-repo::/repo'
    )
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    let rejectOldSearch: (reason: Error) => void = () => {}
    mocks.searchRuntimeFiles.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectOldSearch = reject
        })
    )
    await finishSearch(hook.result.current.executeSearch)
    await finishSearch(hook.result.current.executeSearch)
    await act(async () => rejectOldSearch(new Error('old failure')))
    expect(Object.assign({}, ...updates)).toMatchObject({
      error: null,
      results: RESULTS,
      loading: false
    })
    expect(updates.some((update) => update.error === 'old failure')).toBe(false)
    log.mockRestore()
  })
})
