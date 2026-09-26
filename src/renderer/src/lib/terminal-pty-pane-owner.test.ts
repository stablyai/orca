// Ownership is tab-keyed and layout-sourced: no worktree key, and the tab row's own `ptyId`
// is not a tier. Two panes holding one PTY is the STA-7961 symptom this resolver must refuse.
import { describe, expect, it } from 'vitest'
import {
  listTerminalPtyPaneOwners,
  resolveTerminalPtyPaneOwnership,
  type TerminalPtyPaneOwnerState
} from './terminal-pty-pane-owner'
import type { AppState } from '@/store/types'
import type { TerminalPaneLayoutNode } from '../../../shared/terminal-tab-types'

const PTY_ID = 'wt@@1'

function state(partial: {
  layouts?: Record<
    string,
    { root?: TerminalPaneLayoutNode | null; ptyIdsByLeafId?: Record<string, string> }
  >
  livePtyIds?: Record<string, string[]>
}): TerminalPtyPaneOwnerState {
  return {
    terminalLayoutsByTabId: (partial.layouts ??
      {}) as unknown as AppState['terminalLayoutsByTabId'],
    ptyIdsByTabId: partial.livePtyIds ?? {}
  }
}

function leaf(leafId: string): TerminalPaneLayoutNode {
  return { type: 'leaf', leafId }
}

describe('resolveTerminalPtyPaneOwnership', () => {
  it('reports no owner when nothing binds the pty', () => {
    const s = state({ layouts: { 'tab-a': { root: leaf('leaf-a'), ptyIdsByLeafId: {} } } })
    expect(resolveTerminalPtyPaneOwnership(s, PTY_ID)).toEqual({ kind: 'none' })
  })

  it('finds the one tab whose layout records the pty', () => {
    const s = state({
      layouts: { 'tab-a': { root: leaf('leaf-a'), ptyIdsByLeafId: { 'leaf-a': PTY_ID } } }
    })
    expect(resolveTerminalPtyPaneOwnership(s, PTY_ID)).toEqual({
      kind: 'owned',
      owner: { tabId: 'tab-a', tier: 'recorded' }
    })
  })

  it('counts a rootless layout, which binds its sole pane off-tree', () => {
    const s = state({ layouts: { 'tab-a': { ptyIdsByLeafId: { 'leaf-a': PTY_ID } } } })
    expect(resolveTerminalPtyPaneOwnership(s, PTY_ID)).toEqual({
      kind: 'owned',
      owner: { tabId: 'tab-a', tier: 'recorded' }
    })
  })

  it('does not let an empty binding make a rootless layout look like an owner', () => {
    // The persisted map types its values as a plain string, so '' survives the schema. Counting
    // it would hand a reveal a tab whose named leaf has no session, and adopting it shows nothing.
    const s = state({
      layouts: { 'tab-a': { ptyIdsByLeafId: { 'leaf-empty': '', 'leaf-a': PTY_ID } } }
    })

    expect(resolveTerminalPtyPaneOwnership(s, PTY_ID)).toEqual({
      kind: 'owned',
      owner: { tabId: 'tab-a', tier: 'recorded' }
    })
    expect(resolveTerminalPtyPaneOwnership(s, '')).toEqual({ kind: 'none' })
  })

  it('does not let an empty binding make a rooted layout look like an owner either', () => {
    // The leaf is in the tree, so only the emptiness of the binding can refuse it.
    const s = state({
      layouts: { 'tab-a': { root: leaf('leaf-a'), ptyIdsByLeafId: { 'leaf-a': '' } } }
    })
    expect(resolveTerminalPtyPaneOwnership(s, '')).toEqual({ kind: 'none' })
  })

  it('skips a stranded binding whose leaf already left the tree', () => {
    // The pane was detached; the map entry it left behind reattaches nothing (#13098).
    const s = state({
      layouts: {
        'tab-ghost': { root: leaf('leaf-other'), ptyIdsByLeafId: { 'leaf-a': PTY_ID } },
        'tab-live': { root: leaf('leaf-a'), ptyIdsByLeafId: { 'leaf-a': PTY_ID } }
      }
    })
    expect(resolveTerminalPtyPaneOwnership(s, PTY_ID)).toEqual({
      kind: 'owned',
      owner: { tabId: 'tab-live', tier: 'recorded' }
    })
  })

  it('lets a mounted pane decide over a recorded one', () => {
    const s = state({
      layouts: { 'tab-stale': { root: leaf('leaf-x'), ptyIdsByLeafId: { 'leaf-x': PTY_ID } } },
      livePtyIds: { 'tab-mounted': [PTY_ID] }
    })
    expect(resolveTerminalPtyPaneOwnership(s, PTY_ID)).toEqual({
      kind: 'owned',
      owner: { tabId: 'tab-mounted', tier: 'mounted' }
    })
  })

  it('reports ambiguity when two recorded bindings claim the pty', () => {
    const s = state({
      layouts: {
        'tab-b': { root: leaf('leaf-b'), ptyIdsByLeafId: { 'leaf-b': PTY_ID } },
        'tab-a': { root: leaf('leaf-a'), ptyIdsByLeafId: { 'leaf-a': PTY_ID } }
      }
    })
    const ownership = resolveTerminalPtyPaneOwnership(s, PTY_ID)
    expect(ownership.kind).toBe('ambiguous')
    // Why ordered: persistence order must not decide which claimant the reveal adopts.
    // Why the tiers too: the reveal names every claimant in its warning, and a hinted tab id
    // is not a claimant — only real holders may ever reach that list.
    expect(
      ownership.kind === 'ambiguous' && ownership.owners.map((o) => [o.tabId, o.tier])
    ).toEqual([
      ['tab-a', 'recorded'],
      ['tab-b', 'recorded']
    ])
  })

  it('reports ambiguity when two mounted panes claim the pty', () => {
    const s = state({ livePtyIds: { 'tab-a': [PTY_ID], 'tab-b': [PTY_ID] } })
    expect(resolveTerminalPtyPaneOwnership(s, PTY_ID).kind).toBe('ambiguous')
  })

  it('breaks a same-tier conflict with the pre-minted tab id', () => {
    const s = state({
      layouts: {
        'tab-a': { root: leaf('leaf-a'), ptyIdsByLeafId: { 'leaf-a': PTY_ID } },
        'tab-b': { root: leaf('leaf-b'), ptyIdsByLeafId: { 'leaf-b': PTY_ID } }
      }
    })
    expect(resolveTerminalPtyPaneOwnership(s, PTY_ID, 'tab-b')).toEqual({
      kind: 'owned',
      owner: { tabId: 'tab-b', tier: 'recorded' }
    })
  })

  it('keeps a sole owner over a tab id the pty outgrew', () => {
    // A pane dragged to another tab keeps its leaf binding; the id baked into the PTY env does not move.
    const s = state({
      layouts: {
        'tab-detached-to': { root: leaf('leaf-a'), ptyIdsByLeafId: { 'leaf-a': PTY_ID } }
      }
    })
    expect(resolveTerminalPtyPaneOwnership(s, PTY_ID, 'tab-minted-in')).toEqual({
      kind: 'owned',
      owner: { tabId: 'tab-detached-to', tier: 'recorded' }
    })
  })

  it('leaves a pty nothing holds unowned, however the hint names it', () => {
    // The hint is a tie-break among holders, not a holder: adopting on it is the reveal's policy.
    expect(resolveTerminalPtyPaneOwnership(state({}), PTY_ID, 'tab-hinted')).toEqual({
      kind: 'none'
    })
  })

  it('owns a pty whose only holder is filed under a foreign worktree key', () => {
    // The resolver never reads tabsByWorktree, so a row filed elsewhere is still an owner.
    const s = state({
      layouts: { 'tab-elsewhere': { root: leaf('leaf-a'), ptyIdsByLeafId: { 'leaf-a': PTY_ID } } }
    })
    expect(resolveTerminalPtyPaneOwnership(s, PTY_ID)).toMatchObject({
      kind: 'owned',
      owner: { tabId: 'tab-elsewhere' }
    })
  })
})

describe('listTerminalPtyPaneOwners', () => {
  it('lists every claimant, mounted tier first', () => {
    const s = state({
      layouts: { 'tab-a': { root: leaf('leaf-a'), ptyIdsByLeafId: { 'leaf-a': PTY_ID } } },
      livePtyIds: { 'tab-z': [PTY_ID] }
    })
    expect(listTerminalPtyPaneOwners(s, PTY_ID)).toEqual([
      { tabId: 'tab-z', tier: 'mounted' },
      { tabId: 'tab-a', tier: 'recorded' }
    ])
  })
})
