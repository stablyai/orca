import { describe, expect, it } from 'vitest'
import { shallow } from 'zustand/shallow'
import {
  EMPTY_PALETTE_STATUS_INPUTS,
  selectPaletteIndexStatusSnapshot,
  selectPaletteStatusInputs,
  type PaletteStatusInputsState
} from './worktree-jump-palette-status-inputs'

const BASE: PaletteStatusInputsState = {
  agentStatusByPaneKey: {},
  runtimePaneTitlesByTabId: {},
  ptyIdsByTabId: {},
  terminalLayoutsByTabId: {},
  tabsByWorktree: {},
  unreadTerminalTabs: {},
  unreadAgentCompletionPanes: {}
}

describe('selectPaletteStatusInputs', () => {
  it('returns the shared frozen constant while inactive', () => {
    const inactive = selectPaletteStatusInputs(BASE, false)
    expect(inactive).toBe(EMPTY_PALETTE_STATUS_INPUTS)

    const churned: PaletteStatusInputsState = {
      ...BASE,
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      tabsByWorktree: { 'wt-1': [] }
    }
    const afterChurn = selectPaletteStatusInputs(churned, false)
    expect(afterChurn).toBe(EMPTY_PALETTE_STATUS_INPUTS)
    expect(shallow(inactive, afterChurn)).toBe(true)
  })

  it('exposes the live maps the instant it becomes active', () => {
    const ptyIds = { 'tab-1': ['pty-1'] }
    const active = selectPaletteStatusInputs({ ...BASE, ptyIdsByTabId: ptyIds }, true)
    expect(active.ptyIdsByTabId).toBe(ptyIds)
    expect(active).not.toBe(EMPTY_PALETTE_STATUS_INPUTS)
  })

  it('keeps the tab set live while active so a closing tab can backfill the recent section', () => {
    const tabs = { 'wt-1': [] }
    const closing = selectPaletteStatusInputs({ ...BASE, tabsByWorktree: tabs }, true)
    expect(closing.tabsByWorktree).toBe(tabs)
  })

  // Why this is the load-bearing case: agent transitions and pane-title writes are the hottest
  // writes in the app. If they moved this bundle, the open palette would re-render its whole list
  // on every one of them — which is exactly what the dots' own subscription now covers instead.
  it('does not move when the two hot maps churn while active', () => {
    const r1 = selectPaletteStatusInputs(BASE, true)
    const churned: PaletteStatusInputsState = {
      ...BASE,
      agentStatusByPaneKey: { 'tab-1:leaf-1': {} as never },
      runtimePaneTitlesByTabId: { 'tab-1': { 0: 'claude' } }
    }
    expect(shallow(r1, selectPaletteStatusInputs(churned, true))).toBe(true)
  })

  it('shallow-changes when a subscribed map reference actually changes while active', () => {
    const s1: PaletteStatusInputsState = { ...BASE, ptyIdsByTabId: { 'tab-1': ['pty-1'] } }
    const r1 = selectPaletteStatusInputs(s1, true)
    expect(shallow(r1, selectPaletteStatusInputs(s1, true))).toBe(true)

    const s2: PaletteStatusInputsState = { ...s1, ptyIdsByTabId: { 'tab-1': [] } }
    expect(shallow(r1, selectPaletteStatusInputs(s2, true))).toBe(false)
  })
})

describe('selectPaletteIndexStatusSnapshot', () => {
  it('passes the hot maps through while active', () => {
    const titles = { 'tab-1': { 0: 'claude' } }
    const statuses = { 'tab-1:leaf-1': {} as never }
    const snapshot = selectPaletteIndexStatusSnapshot(
      { ...BASE, runtimePaneTitlesByTabId: titles, agentStatusByPaneKey: statuses },
      true
    )
    expect(snapshot.runtimePaneTitlesByTabId).toBe(titles)
    expect(snapshot.agentStatusByPaneKey).toBe(statuses)
  })

  // Why here and not subscribed: recent-section membership reads these, and the row order is frozen
  // on open — a live unread write would change membership the frozen order can no longer honour.
  it('snapshots the unread maps alongside the status maps', () => {
    const unreadTabs = { 'term-1': true } as const
    const unreadPanes = { 'term-1:leaf-1': true } as const
    const snapshot = selectPaletteIndexStatusSnapshot(
      { ...BASE, unreadTerminalTabs: unreadTabs, unreadAgentCompletionPanes: unreadPanes },
      true
    )
    expect(snapshot.unreadTerminalTabs).toBe(unreadTabs)
    expect(snapshot.unreadAgentCompletionPanes).toBe(unreadPanes)
  })

  it('keeps unread churn out of the subscribed bundle', () => {
    const r1 = selectPaletteStatusInputs(BASE, true)
    const churned: PaletteStatusInputsState = {
      ...BASE,
      unreadTerminalTabs: { 'term-1': true },
      unreadAgentCompletionPanes: { 'term-1:leaf-1': true }
    }
    expect(shallow(r1, selectPaletteStatusInputs(churned, true))).toBe(true)
  })

  it('drops its hold on the live maps once inactive', () => {
    const titles = { 'tab-1': { 0: 'claude' } }
    const inactive = selectPaletteIndexStatusSnapshot(
      { ...BASE, runtimePaneTitlesByTabId: titles },
      false
    )
    expect(inactive.runtimePaneTitlesByTabId).toEqual({})
    // Stable identity, so a closed palette re-reading it can't churn a memo.
    expect(selectPaletteIndexStatusSnapshot(BASE, false)).toBe(inactive)
  })
})
