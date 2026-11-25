// @vitest-environment happy-dom
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { GitHistoryResult } from '../../../../../../shared/git/history/git-history-types'
import { mount, historyProbe, historyResult, mocks } from './git-history-hook-test-harness'
import { gitHistorySlots, publishGitHistory } from './git-history-page-store'

describe('history slot listeners', () => {
  it('does not wake an unrelated retained section when another section reads', async () => {
    mocks.getRuntimeGitHistory.mockResolvedValueOnce(historyResult('b commit'))
    // A retained, collapsed section for B: mounted but not needing history again.
    mount({ worktreeId: 'B', worktreePath: '/b', worktreeMap: new Map([['B', {}]]) })
    await act(() => Promise.resolve())

    const reads = vi.spyOn(gitHistorySlots, 'get')
    const pending = Promise.withResolvers<GitHistoryResult>()
    mocks.getRuntimeGitHistory.mockReturnValueOnce(pending.promise)
    mount({ worktreeId: 'A', worktreeMap: new Map([['A', {}]]) })
    await act(async () => pending.resolve(historyResult('a commit')))

    const sectionBReads = reads.mock.calls.filter(([slotKey]) => slotKey.startsWith('["B"'))
    reads.mockRestore()
    // A's start and settlement publish only to A's readers.
    expect(sectionBReads).toEqual([])
  })

  it('keeps a mounted section’s page while other sections fill the cache', async () => {
    mocks.getRuntimeGitHistory.mockResolvedValueOnce(historyResult('a commit'))
    mount({ worktreeId: 'A' })
    await act(() => Promise.resolve())
    expect(historyProbe.current?.gitHistoryState.status).toBe('ready')

    await act(async () => {
      for (let index = 0; index < 300; index += 1) {
        publishGitHistory(`other-${index}`, { key: null, state: { status: 'loading' } })
      }
    })

    // Unread pages are evicted first, as when every read woke every section.
    expect(historyProbe.current?.gitHistoryState.result?.items[0].subject).toBe('a commit')
    for (let index = 0; index < 300; index += 1) {
      gitHistorySlots.delete(`other-${index}`)
    }
  })
})
