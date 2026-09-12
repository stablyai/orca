import { describe, expect, it } from 'vitest'
import { shouldRetainDisposedPaneSpawn } from './disposed-spawn-retention'

const WT = 'wt'
const TAB = 'tab-a'
const LEAF = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF = '22222222-2222-4222-8222-222222222222'

function state(overrides: {
  tabs?: Record<string, { id: string }[]>
  layouts?: Record<string, { root: unknown }>
  deleting?: Record<string, { isDeleting: boolean }>
}) {
  return {
    tabsByWorktree: (overrides.tabs ?? { [WT]: [{ id: TAB }] }) as never,
    terminalLayoutsByTabId: (overrides.layouts ?? {}) as never,
    deleteStateByWorktreeId: (overrides.deleting ?? {}) as never
  }
}

describe('shouldRetainDisposedPaneSpawn', () => {
  it('keeps the PTY for a tab that still exists and has no persisted layout yet', () => {
    // A brand-new single-pane tab has no layout row until its first pane binds.
    expect(shouldRetainDisposedPaneSpawn(state({}), WT, TAB, LEAF)).toBe(true)
  })

  it('keeps the PTY when the layout still names the leaf', () => {
    expect(
      shouldRetainDisposedPaneSpawn(
        state({ layouts: { [TAB]: { root: { type: 'leaf', leafId: LEAF } } } }),
        WT,
        TAB,
        LEAF
      )
    ).toBe(true)
  })

  it('kills the PTY when the tab is gone from every worktree', () => {
    expect(
      shouldRetainDisposedPaneSpawn(state({ tabs: { [WT]: [{ id: 'other-tab' }] } }), WT, TAB, LEAF)
    ).toBe(false)
  })

  it('kills the PTY when the leaf was removed from a split layout', () => {
    expect(
      shouldRetainDisposedPaneSpawn(
        state({ layouts: { [TAB]: { root: { type: 'leaf', leafId: OTHER_LEAF } } } }),
        WT,
        TAB,
        LEAF
      )
    ).toBe(false)
  })

  it('kills the PTY when the worktree is being deleted even though its tab is still listed', () => {
    // The teardown kills from the bound-id ledger, which never recorded an in-flight spawn.
    expect(
      shouldRetainDisposedPaneSpawn(
        state({ deleting: { [WT]: { isDeleting: true } } }),
        WT,
        TAB,
        LEAF
      )
    ).toBe(false)
    expect(
      shouldRetainDisposedPaneSpawn(
        state({ deleting: { other: { isDeleting: true } } }),
        WT,
        TAB,
        LEAF
      )
    ).toBe(true)
  })

  it('finds the tab under a worktree other than the one it was opened in', () => {
    // A tab moved between worktrees mid-spawn is still a live surface.
    expect(
      shouldRetainDisposedPaneSpawn(
        state({ tabs: { [WT]: [], other: [{ id: TAB }] } }),
        WT,
        TAB,
        LEAF
      )
    ).toBe(true)
  })
})
