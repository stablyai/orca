import { describe, expect, it } from 'vitest'
import { getWorktreeStatus, getWorktreeStatusLabel, resolveWorktreeStatus } from './worktree-status'

// Why: build a live-pty map from tab ids so each test can declare which
// tabs are alive without manually tracking parallel `tab.ptyId` values.
// `tab.ptyId` is the wake-hint sessionId preserved across sleep, not a
// liveness signal — slept-tab tests below pin the gap.
function livePtyMap(...tabIds: string[]): Record<string, string[]> {
  return Object.fromEntries(tabIds.map((id, i) => [id, [`pty-${i}`]]))
}

describe('getWorktreeStatus', () => {
  it('prioritizes permission over other live activity states', () => {
    const status = getWorktreeStatus(
      [
        { id: 'tab-1', title: 'claude [working]' },
        { id: 'tab-2', title: 'claude [permission]' }
      ],
      [{ id: 'browser-1' }],
      livePtyMap('tab-1', 'tab-2')
    )

    expect(status).toBe('permission')
    expect(getWorktreeStatusLabel(status)).toBe('Needs permission')
  })

  it('treats browser-only worktrees as active', () => {
    const status = getWorktreeStatus([], [{ id: 'browser-1' }], {})

    expect(status).toBe('active')
  })

  it('returns inactive when neither tabs nor browser state are live', () => {
    expect(getWorktreeStatus([], [], {})).toBe('inactive')
  })

  it('reports working when any pane in a split-pane tab is working even if tab.title is idle', () => {
    // Regression: clicking between split panes rewrites tab.title to the
    // focused pane's title (see onActivePaneChange in
    // use-terminal-pane-lifecycle.ts). If the focused pane is idle while
    // another pane is still working, the sidebar spinner must stay spinning.
    const status = getWorktreeStatus(
      [{ id: 'tab-1', title: 'claude [done]' }],
      [],
      livePtyMap('tab-1'),
      { 'tab-1': { 0: 'codex [working]', 1: 'claude [done]' } }
    )

    expect(status).toBe('working')
  })

  it('prefers pane-level permission status over tab.title', () => {
    const status = getWorktreeStatus(
      [{ id: 'tab-1', title: 'claude [done]' }],
      [],
      livePtyMap('tab-1'),
      { 'tab-1': { 0: 'claude [permission]', 1: 'claude [done]' } }
    )

    expect(status).toBe('permission')
  })

  // Why: sleep clears ptyIdsByTabId[tab.id] to [] but preserves tab.ptyId
  // as a wake-hint sessionId. Reading tab.ptyId for liveness was the bug —
  // pin the new behavior so it can't regress.
  it('returns inactive for a slept tab (ptyIdsByTabId empty even if heuristic title matches working)', () => {
    const status = getWorktreeStatus([{ id: 'tab-1', title: 'claude [working]' }], [], {
      'tab-1': []
    })

    expect(status).toBe('inactive')
  })

  it('returns active when ptyIdsByTabId has entries (live precondition)', () => {
    const status = getWorktreeStatus([{ id: 'tab-1', title: 'bash' }], [], livePtyMap('tab-1'))

    expect(status).toBe('active')
  })
})

describe('resolveWorktreeStatus', () => {
  it('returns inactive when no tab has a live pty and no explicit agent row exists', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: 'claude [done]' }],
      browserTabs: [],
      // Slept: live-pty array empty; tab.ptyId would be the wake-hint sessionId.
      ptyIdsByTabId: { 'tab-1': [] },
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveDone: false,
      hasRetainedDone: false
    })

    expect(status).toBe('inactive')
  })

  it('promotes to done when a retained done row is visible, even without a live pty', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: 'bash' }],
      browserTabs: [],
      ptyIdsByTabId: { 'tab-1': [] },
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveDone: false,
      hasRetainedDone: true
    })

    expect(status).toBe('done')
  })

  it('promotes to permission when an explicit agent row needs input, even without a live pty', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: 'claude [permission]' }],
      browserTabs: [],
      ptyIdsByTabId: { 'tab-1': [] },
      hasPermission: true,
      hasLiveWorking: false,
      hasLiveDone: false,
      hasRetainedDone: false
    })

    expect(status).toBe('permission')
  })

  it('promotes to permission when live and hasPermission', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: 'bash' }],
      browserTabs: [],
      ptyIdsByTabId: livePtyMap('tab-1'),
      hasPermission: true,
      hasLiveWorking: false,
      hasLiveDone: false,
      hasRetainedDone: false
    })

    expect(status).toBe('permission')
  })

  it('promotes to working from a fresh explicit agent row before pane titles restore', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: 'bash' }],
      browserTabs: [],
      ptyIdsByTabId: livePtyMap('tab-1'),
      hasPermission: false,
      hasLiveWorking: true,
      hasLiveDone: false,
      hasRetainedDone: false
    })

    expect(status).toBe('working')
  })

  it('lets heuristic working beat hasLiveDone (newer in-progress signal wins)', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: 'claude [working]' }],
      browserTabs: [],
      ptyIdsByTabId: livePtyMap('tab-1'),
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveDone: true,
      hasRetainedDone: false
    })

    expect(status).toBe('working')
  })

  // Why: title-heuristic permission must beat hasLiveDone/hasRetainedDone —
  // the priority "permission > working > done > heuristic" applies to BOTH
  // sources of permission (the args.hasPermission overlay AND the heuristic
  // 'permission' return). Otherwise a tab title scraping "permission" would
  // be silently downgraded to 'done' whenever a separate done overlay exists.
  it('honors heuristic permission over hasLiveDone (priority: permission > done)', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: 'claude [permission]' }],
      browserTabs: [],
      ptyIdsByTabId: livePtyMap('tab-1'),
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveDone: true,
      hasRetainedDone: false
    })

    expect(status).toBe('permission')
  })

  it('promotes to done when live and hasRetainedDone (no working heuristic)', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: 'bash' }],
      browserTabs: [],
      ptyIdsByTabId: livePtyMap('tab-1'),
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveDone: false,
      hasRetainedDone: true
    })

    expect(status).toBe('done')
  })

  it('falls through to active heuristic when nothing else applies', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: 'bash' }],
      browserTabs: [],
      ptyIdsByTabId: livePtyMap('tab-1'),
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveDone: false,
      hasRetainedDone: false
    })

    expect(status).toBe('active')
  })
})
