// @vitest-environment happy-dom
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { GitHistoryResult } from '../../../../../../shared/git/history/git-history-types'
import { mount, historyProbe, historyResult, mocks } from './git-history-hook-test-harness'
import { gitHistorySlots, publishGitHistory, subscribeGitHistory } from './git-history-page-store'

const CAP = 256
const page = { key: null, state: { status: 'loading' as const } }

function fillResidents(): string[] {
  const residents = Array.from({ length: CAP }, (_, index) => `resident-${index}`)
  for (const slotKey of residents) {
    publishGitHistory(slotKey, page)
  }
  return residents
}

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

  it('evicts without visiting subscribed slots that hold no page', () => {
    const residents = fillResidents()
    // Retained folder bodies subscribe with no resident page and the menu closed.
    const unsubscribes = Array.from({ length: 600 }, (_, index) =>
      subscribeGitHistory(`reader-${index}`, () => {})
    )
    const reads = vi.spyOn(gitHistorySlots, 'get')

    publishGitHistory('absent', page)

    const lookups = reads.mock.calls.length
    reads.mockRestore()
    expect(lookups).toBe(0)
    expect(gitHistorySlots.has('resident-0')).toBe(false)
    expect(gitHistorySlots.has('absent')).toBe(true)
    for (const unsubscribe of unsubscribes) {
      unsubscribe()
    }
    for (const slotKey of [...residents, 'absent']) {
      gitHistorySlots.delete(slotKey)
    }
  })

  it('evicts a page whose last reader left, and tells readers when every page is read', () => {
    const residents = fillResidents()
    const wakes = new Map<string, number>()
    const unsubscribes = new Map(
      residents.map((slotKey) => [
        slotKey,
        subscribeGitHistory(slotKey, () => wakes.set(slotKey, (wakes.get(slotKey) ?? 0) + 1))
      ])
    )
    unsubscribes.get('resident-5')!()
    unsubscribes.delete('resident-5')

    publishGitHistory('first', page)
    // The final unsubscribe made resident-5 the only unread page, so older read pages stay.
    expect(gitHistorySlots.has('resident-5')).toBe(false)
    expect(gitHistorySlots.has('resident-0')).toBe(true)
    expect(wakes.size).toBe(0)

    const firstReader = subscribeGitHistory('first', () => {})
    publishGitHistory('second', page)
    // Every resident is read: the least recent page goes and its readers learn it.
    expect(gitHistorySlots.has('resident-0')).toBe(false)
    expect(wakes.get('resident-0')).toBe(1)
    expect(wakes.size).toBe(1)

    firstReader()
    for (const unsubscribe of unsubscribes.values()) {
      unsubscribe()
    }
    for (const slotKey of [...residents, 'first', 'second']) {
      gitHistorySlots.delete(slotKey)
    }
  })
})
