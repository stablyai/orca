import { describe, expect, it } from 'vitest'
import {
  resolveTerminalTabIdForPtyId,
  resolveTerminalTabPtyOwnership,
  type TerminalTabPtyOwnershipState
} from './terminal-tab-for-pty-id'
import type { AppState } from '@/store/types'

function state(partial: {
  tabs?: Record<string, { id: string; ptyId?: string | null }[]>
  layouts?: Record<string, { ptyIdsByLeafId?: Record<string, string> }>
  livePtyIds?: Record<string, string[]>
}): TerminalTabPtyOwnershipState {
  return {
    tabsByWorktree: (partial.tabs ?? {}) as unknown as AppState['tabsByWorktree'],
    terminalLayoutsByTabId: (partial.layouts ??
      {}) as unknown as AppState['terminalLayoutsByTabId'],
    ptyIdsByTabId: partial.livePtyIds ?? {}
  }
}

describe('resolveTerminalTabIdForPtyId', () => {
  it('returns null when stale persistence binds the ptyId to multiple tabs', () => {
    const s = state({
      tabs: {
        wt: [
          { id: 'tab-a', ptyId: 'wt@@1' },
          { id: 'tab-b', ptyId: null }
        ]
      },
      layouts: { 'tab-b': { ptyIdsByLeafId: { leaf2: 'wt@@1' } } }
    })
    expect(resolveTerminalTabIdForPtyId(s, 'wt', 'wt@@1')).toBeNull()
  })
})

describe('resolveTerminalTabPtyOwnership', () => {
  const staleLayoutBesideMountedTab = state({
    tabs: {
      wt: [
        { id: 'tab-stale', ptyId: null },
        { id: 'tab-mounted', ptyId: null }
      ]
    },
    layouts: { 'tab-stale': { ptyIdsByLeafId: { leaf1: 'wt@@1' } } },
    livePtyIds: { 'tab-mounted': ['wt@@1'] }
  })

  it('keeps the mounted pane even when the hint names the stale tab', () => {
    expect(
      resolveTerminalTabPtyOwnership(staleLayoutBesideMountedTab, 'wt', 'wt@@1', {
        preferTabId: 'tab-stale'
      })
    ).toEqual({ kind: 'owned', tabId: 'tab-mounted' })
  })

  it('keeps a sole wake hint over a tab id the PTY outgrew', () => {
    // Pane moves change tab.ptyId, but PTY environment tab IDs are immutable after spawn.
    const s = state({
      tabs: {
        wt: [
          { id: 'tab-minted-in', ptyId: null },
          { id: 'tab-detached-to', ptyId: 'wt@@1' }
        ]
      }
    })
    expect(
      resolveTerminalTabPtyOwnership(s, 'wt', 'wt@@1', { preferTabId: 'tab-minted-in' })
    ).toEqual({ kind: 'owned', tabId: 'tab-detached-to' })
  })

  it('keeps a sole layout row over a tab id the PTY outgrew', () => {
    const s = state({
      tabs: {
        wt: [
          { id: 'tab-minted-in', ptyId: null },
          { id: 'tab-detached-to', ptyId: null }
        ]
      },
      layouts: { 'tab-detached-to': { ptyIdsByLeafId: { leaf1: 'wt@@1' } } }
    })
    expect(
      resolveTerminalTabPtyOwnership(s, 'wt', 'wt@@1', { preferTabId: 'tab-minted-in' })
    ).toEqual({ kind: 'owned', tabId: 'tab-detached-to' })
  })

  it('falls back to the pre-minted tab id when nothing records the ptyId', () => {
    const s = state({
      tabs: {
        wt: [
          { id: 'tab-other', ptyId: 'wt@@2' },
          { id: 'tab-hinted', ptyId: null }
        ]
      }
    })
    expect(resolveTerminalTabPtyOwnership(s, 'wt', 'wt@@1', { preferTabId: 'tab-hinted' })).toEqual(
      { kind: 'owned', tabId: 'tab-hinted' }
    )
  })

  it('reports ambiguity when only recorded bindings claim the ptyId', () => {
    const s = state({
      tabs: {
        wt: [
          { id: 'tab-a', ptyId: 'wt@@1' },
          { id: 'tab-b', ptyId: null }
        ]
      },
      layouts: { 'tab-b': { ptyIdsByLeafId: { leaf2: 'wt@@1' } } }
    })
    expect(resolveTerminalTabPtyOwnership(s, 'wt', 'wt@@1')).toEqual({ kind: 'ambiguous' })
  })

  it('breaks a recorded ownership conflict with the pre-minted tab id', () => {
    const s = state({
      tabs: {
        wt: [
          { id: 'tab-a', ptyId: 'wt@@1' },
          { id: 'tab-b', ptyId: null }
        ]
      },
      layouts: { 'tab-b': { ptyIdsByLeafId: { leaf2: 'wt@@1' } } }
    })
    expect(resolveTerminalTabPtyOwnership(s, 'wt', 'wt@@1', { preferTabId: 'tab-b' })).toEqual({
      kind: 'owned',
      tabId: 'tab-b'
    })
  })

  it('breaks a mounted ownership conflict with the pre-minted tab id', () => {
    const s = state({
      tabs: {
        wt: [
          { id: 'tab-a', ptyId: null },
          { id: 'tab-b', ptyId: null }
        ]
      },
      livePtyIds: { 'tab-a': ['wt@@1'], 'tab-b': ['wt@@1'] }
    })
    expect(resolveTerminalTabPtyOwnership(s, 'wt', 'wt@@1')).toEqual({ kind: 'ambiguous' })
    expect(resolveTerminalTabPtyOwnership(s, 'wt', 'wt@@1', { preferTabId: 'tab-b' })).toEqual({
      kind: 'owned',
      tabId: 'tab-b'
    })
  })
})
