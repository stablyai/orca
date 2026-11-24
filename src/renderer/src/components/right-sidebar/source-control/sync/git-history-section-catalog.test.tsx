// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitHistoryResult } from '../../../../../../shared/git/history/git-history-types'

// A folder section reads its scope from context; the ordinary panel has none.
const scopeState = vi.hoisted(() => ({ current: null as { worktreeId: string } | null }))
vi.mock('../panel/worktree-scope', () => ({
  useSourceControlScope: () => scopeState.current,
  sourceControlConnectionId: () => undefined
}))

import { Probe, mount, historyResult, mocks } from './git-history-hook-test-harness'
import { gitHistorySlots, latestGitHistoryRequest } from './git-history-page-store'

/** A worktree catalog that counts membership checks. */
class CountingMap extends Map<string, unknown> {
  lookups = 0
  override has(key: string): boolean {
    this.lookups += 1
    return super.has(key)
  }
}

const RETAINED = 100

function slotOf(worktreeId: string): string {
  return [...latestGitHistoryRequest.keys()].find((key) => key.startsWith(`["${worktreeId}"`))!
}

afterEach(() => {
  scopeState.current = null
})

describe('history retirement across folder sections', () => {
  it('mounting a folder section neither sweeps nor retires other worktrees’ history', async () => {
    const catalog = new Map<string, unknown>([
      ['P', {}],
      ['X', {}],
      ['Y', {}]
    ])
    // X: an extant worktree with a cached page, no longer shown.
    mocks.getRuntimeGitHistory.mockResolvedValueOnce(historyResult('x commit'))
    const x = mount({ worktreeId: 'X', worktreePath: '/x', worktreeMap: catalog })
    await act(() => Promise.resolve())
    const xSlot = slotOf('X')
    x.unmount()
    // Y: an extant worktree whose read is still held.
    const heldY = Promise.withResolvers<GitHistoryResult>()
    mocks.getRuntimeGitHistory.mockReturnValueOnce(heldY.promise)
    const y = mount({ worktreeId: 'Y', worktreePath: '/y', worktreeMap: catalog })
    const ySlot = slotOf('Y')
    y.unmount()
    for (let index = 0; index < RETAINED; index += 1) {
      catalog.set(`w${index}`, {})
      latestGitHistoryRequest.set(`slot-w${index}`, { worktreeId: `w${index}`, id: -index })
    }
    const panel = mount({ worktreeId: 'P', worktreePath: '/p', worktreeMap: catalog })
    panel.unmount()

    // Switch to a folder workspace: a newly mounted section, scope menu closed, catalog unchanged.
    scopeState.current = { worktreeId: 'S' }
    const sectionCatalog = new CountingMap([['S', {}]])
    await act(async () => {
      mount({
        worktreeId: 'S',
        worktreePath: '/s',
        worktreeMap: sectionCatalog,
        isGitHistoryNeeded: false
      })
    })

    // Only the section's own membership, never one visit per retained request.
    expect(sectionCatalog.lookups).toBeLessThan(RETAINED)
    expect(gitHistorySlots.get(xSlot)?.state.result?.items[0].subject).toBe('x commit')
    expect(latestGitHistoryRequest.has(xSlot)).toBe(true)
    expect(latestGitHistoryRequest.has(ySlot)).toBe(true)
    expect(latestGitHistoryRequest.has('slot-w0')).toBe(true)
    await act(async () => heldY.resolve(historyResult('y commit')))
    expect(gitHistorySlots.get(ySlot)?.state.result?.items[0].subject).toBe('y commit')
  })

  it('removing a worktree publishes only the held reply of the one that remains', async () => {
    const both = new Map<string, unknown>([
      ['A', {}],
      ['B', {}]
    ])
    const heldA = Promise.withResolvers<GitHistoryResult>()
    const heldB = Promise.withResolvers<GitHistoryResult>()
    mocks.getRuntimeGitHistory.mockReturnValueOnce(heldA.promise)
    const a = mount({ worktreeId: 'A', worktreeMap: both })
    const aSlot = slotOf('A')
    mocks.getRuntimeGitHistory.mockReturnValueOnce(heldB.promise)
    const b = mount({ worktreeId: 'B', worktreePath: '/b', worktreeMap: both })
    const bSlot = slotOf('B')

    const onlyB = new Map<string, unknown>([['B', {}]])
    await act(async () => {
      a.rerender(<Probe worktreeId="A" worktreeMap={onlyB} />)
      b.rerender(<Probe worktreeId="B" worktreePath="/b" worktreeMap={onlyB} />)
    })
    await act(async () => {
      heldA.resolve(historyResult('a commit'))
      heldB.resolve(historyResult('b commit'))
    })

    expect(gitHistorySlots.has(aSlot)).toBe(false)
    expect(latestGitHistoryRequest.has(aSlot)).toBe(false)
    expect(gitHistorySlots.get(bSlot)?.state.result?.items[0].subject).toBe('b commit')
    expect(mocks.getRuntimeGitHistory).toHaveBeenCalledTimes(2)
  })
})
