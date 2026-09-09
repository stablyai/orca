import { beforeEach, describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import {
  getHibernationBoundaryResolvedAtByPaneKey,
  getHibernationPtyBindingFirstSeenAtByPaneKey,
  observeHibernationPtyBindings,
  recordHibernationBoundaryResolved,
  resetHibernationPaneAgeForTests
} from './agent-hibernation-pane-age'

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = `tab-1:${LEAF}`
const IDLE_MS = 30 * 60 * 1000

function tab(id = 'tab-1'): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: 'wt-bg',
    title: 'Agent',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function layout(ptyId: string | null): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId: LEAF },
    activeLeafId: LEAF,
    expandedLeafId: null,
    ptyIdsByLeafId: ptyId ? { [LEAF]: ptyId } : {}
  }
}

function observe(ptyId: string | null, now: number, tabs: TerminalTab[] = [tab()]): void {
  observeHibernationPtyBindings({
    tabsByWorktree: { 'wt-bg': tabs },
    terminalLayoutsByTabId: { 'tab-1': layout(ptyId) },
    now,
    idleMs: IDLE_MS
  })
}

describe('hibernation PTY binding age', () => {
  beforeEach(() => {
    resetHibernationPaneAgeForTests()
  })

  it('stamps first sight and carries it while the PTY is unchanged', () => {
    observe('pty-1', 1_000)
    observe('pty-1', 500_000)
    expect(getHibernationPtyBindingFirstSeenAtByPaneKey()[PANE]).toBe(1_000)
  })

  it('resets the stamp when the pane rebinds to a new PTY', () => {
    // A wake spawns a fresh PTY; the pane must get a full idle window again.
    observe('pty-1', 1_000)
    observe('pty-2', 500_000)
    expect(getHibernationPtyBindingFirstSeenAtByPaneKey()[PANE]).toBe(500_000)
  })

  it('keeps accumulated age across a transient layout gap', () => {
    // The planner already fails closed during the gap; dropping the binding here would
    // hand the same PTY a fresh idle window every time the layout flickers.
    observe('pty-1', 1_000)
    recordHibernationBoundaryResolved(PANE, 1_500)
    observe(null, 2_000)
    expect(getHibernationPtyBindingFirstSeenAtByPaneKey()[PANE]).toBe(1_000)
    expect(getHibernationBoundaryResolvedAtByPaneKey()[PANE]).toBe(1_500)
    observe('pty-1', 3_000)
    expect(getHibernationPtyBindingFirstSeenAtByPaneKey()[PANE]).toBe(1_000)
    expect(getHibernationBoundaryResolvedAtByPaneKey()[PANE]).toBe(1_500)
  })

  it('expires an unseen binding once it is older than the idle window', () => {
    observe('pty-1', 1_000)
    recordHibernationBoundaryResolved(PANE, 1_000)
    observe(null, 1_000 + IDLE_MS + 1)
    expect(getHibernationPtyBindingFirstSeenAtByPaneKey()[PANE]).toBeUndefined()
    expect(getHibernationBoundaryResolvedAtByPaneKey()[PANE]).toBeUndefined()
  })

  it('drops bindings and boundary stamps when the tab is authoritatively gone', () => {
    observe('pty-1', 1_000)
    recordHibernationBoundaryResolved(PANE, 1_000)
    observe(null, 2_000, [])
    expect(getHibernationPtyBindingFirstSeenAtByPaneKey()[PANE]).toBeUndefined()
    expect(getHibernationBoundaryResolvedAtByPaneKey()[PANE]).toBeUndefined()
  })
})
