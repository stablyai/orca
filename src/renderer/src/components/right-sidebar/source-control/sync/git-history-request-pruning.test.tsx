// @vitest-environment happy-dom
import { act } from 'react'
import { describe, expect, it } from 'vitest'
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

describe('history request pruning', () => {
  it('does not sweep retained requests on a workspace switch with an unchanged catalog', async () => {
    const catalog = new CountingMap([
      ['A', {}],
      ['B', {}]
    ])
    for (let index = 0; index < RETAINED; index += 1) {
      catalog.set(`w${index}`, {})
      latestGitHistoryRequest.set(`slot-w${index}`, { worktreeId: `w${index}`, id: index })
    }
    const root = mount({ worktreeId: 'A', worktreeMap: catalog, isGitHistoryNeeded: false })
    catalog.lookups = 0

    await act(async () =>
      root.rerender(<Probe worktreeId="B" worktreeMap={catalog} isGitHistoryNeeded={false} />)
    )

    // Only B's own membership; on a catalog change the sweep still runs (next test).
    expect(catalog.lookups).toBeLessThan(RETAINED)
  })

  it('retires a removed worktree’s page and request once the catalog drops it', async () => {
    mocks.getRuntimeGitHistory.mockResolvedValueOnce(historyResult('a commit'))
    const root = mount({ worktreeId: 'A' })
    await act(() => Promise.resolve())
    const slotKey = [...latestGitHistoryRequest.keys()].find((key) => key.startsWith('["A"'))
    expect(slotKey && gitHistorySlots.has(slotKey)).toBe(true)

    await act(async () =>
      root.rerender(<Probe worktreeId="B" worktreePath="/b" worktreeMap={new Map([['B', {}]])} />)
    )

    expect(latestGitHistoryRequest.has(slotKey!)).toBe(false)
    expect(gitHistorySlots.has(slotKey!)).toBe(false)
  })

  it('retires a closed section’s page at the next switch in a panel whose catalog lacks it', async () => {
    mocks.getRuntimeGitHistory.mockResolvedValueOnce(historyResult('a commit'))
    const section = mount({ worktreeId: 'A', worktreeMap: new Map([['A', {}]]) })
    await act(() => Promise.resolve())
    const slotKey = [...latestGitHistoryRequest.keys()].find((key) => key.startsWith('["A"'))!
    const panelCatalog = new Map([
      ['B', {}],
      ['C', {}]
    ])
    const panel = mount({
      worktreeId: 'B',
      worktreePath: '/b',
      worktreeMap: panelCatalog,
      isGitHistoryNeeded: false
    })
    section.unmount()
    expect(gitHistorySlots.has(slotKey)).toBe(true)

    await act(async () =>
      panel.rerender(
        <Probe
          worktreeId="C"
          worktreePath="/c"
          worktreeMap={panelCatalog}
          isGitHistoryNeeded={false}
        />
      )
    )

    expect(latestGitHistoryRequest.has(slotKey)).toBe(false)
    expect(gitHistorySlots.has(slotKey)).toBe(false)
  })
})
