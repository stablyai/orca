/**
 * Perf regression: setCacheTimerStartedAt and setTabLayout must not publish
 * state when the write is a no-op.
 *
 * Both actions previously spread a fresh object and returned it unconditionally,
 * so every redundant call produced a new AppState object and woke EVERY zustand
 * subscriber — which, with per-pane selectors across all mounted panes, is an
 * O(panes) sweep per write. The cadence is real: parked-terminal-byte-watcher
 * writes a null cache timer on every agent working/exit/stale-title transition,
 * and TerminalPane re-persists its layout on pane-title churn.
 *
 * These tests count subscriber wakeups on a real store; the pre-fix numbers are
 * 1_000 (one per call), the post-fix numbers are 0.
 */
import { describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { createTestStore, makeTab, makeWorktree } from './store-test-helpers'

const REPEATS = 1_000

function makeLayout(overrides: Partial<TerminalLayoutSnapshot> = {}): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'vertical',
      ratio: 0.5,
      first: { type: 'leaf', leafId: 'leaf-a' },
      second: { type: 'leaf', leafId: 'leaf-b' }
    },
    activeLeafId: 'leaf-a',
    expandedLeafId: null,
    ptyIdsByLeafId: { 'leaf-a': 'pty-a', 'leaf-b': 'pty-b' },
    titlesByLeafId: { 'leaf-a': 'build' },
    ...overrides
  }
}

describe('setCacheTimerStartedAt identity bailout', () => {
  it('wakes zero subscribers across 1,000 null-over-null writes', () => {
    const store = createTestStore()
    const paneKey = 'tab-1:leaf-a'
    store.getState().setCacheTimerStartedAt(paneKey, null)

    let wakeups = 0
    const unsubscribe = store.subscribe(() => {
      wakeups += 1
    })
    for (let i = 0; i < REPEATS; i += 1) {
      store.getState().setCacheTimerStartedAt(paneKey, null)
    }
    unsubscribe()

    expect(wakeups).toBe(0)
    expect(store.getState().cacheTimerByKey[paneKey]).toBeNull()
  })

  it('wakes zero subscribers across 1,000 repeats of the same timestamp', () => {
    const store = createTestStore()
    const paneKey = 'tab-1:leaf-a'
    store.getState().setCacheTimerStartedAt(paneKey, 1_700_000_000_000)

    let wakeups = 0
    const unsubscribe = store.subscribe(() => {
      wakeups += 1
    })
    for (let i = 0; i < REPEATS; i += 1) {
      store.getState().setCacheTimerStartedAt(paneKey, 1_700_000_000_000)
    }
    unsubscribe()

    expect(wakeups).toBe(0)
  })

  it('still publishes when the timestamp actually changes', () => {
    const store = createTestStore()
    const paneKey = 'tab-1:leaf-a'
    store.getState().setCacheTimerStartedAt(paneKey, null)

    let wakeups = 0
    const unsubscribe = store.subscribe(() => {
      wakeups += 1
    })
    store.getState().setCacheTimerStartedAt(paneKey, 123)
    store.getState().setCacheTimerStartedAt(paneKey, null)
    unsubscribe()

    expect(wakeups).toBe(2)
    expect(store.getState().cacheTimerByKey[paneKey]).toBeNull()
  })

  it('records the first write for a key even when the value is null', () => {
    const store = createTestStore()
    const paneKey = 'tab-1:leaf-a'

    let wakeups = 0
    const unsubscribe = store.subscribe(() => {
      wakeups += 1
    })
    store.getState().setCacheTimerStartedAt(paneKey, null)
    unsubscribe()

    expect(wakeups).toBe(1)
    expect(paneKey in store.getState().cacheTimerByKey).toBe(true)
  })

  it('still clears a stale :seed sentinel when the pane value is unchanged', () => {
    // Without this carve-out the bailout would strand the sentinel and leave a phantom timer.
    const store = createTestStore()
    const paneKey = 'tab-1:leaf-a'
    store.getState().setCacheTimerStartedAt(paneKey, null)
    store.setState((s) => ({ cacheTimerByKey: { ...s.cacheTimerByKey, 'tab-1:seed': 42 } }))

    store.getState().setCacheTimerStartedAt(paneKey, null)

    expect('tab-1:seed' in store.getState().cacheTimerByKey).toBe(false)
  })
})

describe('setTabLayout identity bailout', () => {
  it('wakes zero subscribers across 1,000 structurally identical snapshots', () => {
    const store = createTestStore()
    store.getState().setTabLayout('tab-1', makeLayout())

    let wakeups = 0
    const unsubscribe = store.subscribe(() => {
      wakeups += 1
    })
    for (let i = 0; i < REPEATS; i += 1) {
      // Fresh object each iteration: this is what persistLayoutSnapshot produces.
      store.getState().setTabLayout('tab-1', makeLayout())
    }
    unsubscribe()

    expect(wakeups).toBe(0)
  })

  it('keeps the stored snapshot reference stable when nothing changed', () => {
    const store = createTestStore()
    store.getState().setTabLayout('tab-1', makeLayout())
    const first = store.getState().terminalLayoutsByTabId['tab-1']

    store.getState().setTabLayout('tab-1', makeLayout())

    expect(store.getState().terminalLayoutsByTabId['tab-1']).toBe(first)
  })

  it('publishes when any tracked field changes', () => {
    const store = createTestStore()
    store.getState().setTabLayout('tab-1', makeLayout())

    const mutations: Partial<TerminalLayoutSnapshot>[] = [
      { activeLeafId: 'leaf-b' },
      { expandedLeafId: 'leaf-a' },
      { chatLeafId: 'leaf-b' },
      { titlesByLeafId: { 'leaf-a': 'test' } },
      { ptyIdsByLeafId: { 'leaf-a': 'pty-a', 'leaf-b': 'pty-c' } },
      { buffersByLeafId: { 'leaf-a': 'scrollback' } },
      { scrollbackRefsByLeafId: { 'leaf-a': 'ref-1' } },
      {
        root: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.5,
          first: { type: 'leaf', leafId: 'leaf-a' },
          second: { type: 'leaf', leafId: 'leaf-b' }
        }
      },
      {
        root: {
          type: 'split',
          direction: 'vertical',
          ratio: 0.7,
          first: { type: 'leaf', leafId: 'leaf-a' },
          second: { type: 'leaf', leafId: 'leaf-b' }
        }
      }
    ]

    for (const mutation of mutations) {
      store.getState().setTabLayout('tab-1', makeLayout())
      let wakeups = 0
      const unsubscribe = store.subscribe(() => {
        wakeups += 1
      })
      store.getState().setTabLayout('tab-1', makeLayout(mutation))
      unsubscribe()
      expect(wakeups, `expected a publish for ${JSON.stringify(mutation)}`).toBe(1)
    }
  })

  it('does not fire pane-ownership transfers for a bailed-out identical layout', () => {
    // A duplicate-pty layout normalizes to a transfer; replaying the already-normalized
    // snapshot must be inert, since normalization then finds nothing to move.
    const store = createTestStore()
    const duplicate = makeLayout({
      ptyIdsByLeafId: { 'leaf-a': 'pty-a', 'leaf-b': 'pty-a' }
    })
    store.getState().setTabLayout('tab-1', duplicate)
    const normalized = store.getState().terminalLayoutsByTabId['tab-1']
    expect(normalized.ptyIdsByLeafId).not.toEqual(duplicate.ptyIdsByLeafId)

    store.getState().markTerminalPaneUnread('tab-1:leaf-a', 'terminal-bell')
    const beforeUnread = { ...store.getState().unreadTerminalPanes }

    for (let i = 0; i < REPEATS; i += 1) {
      store.getState().setTabLayout('tab-1', { ...normalized })
    }

    expect(store.getState().terminalLayoutsByTabId['tab-1']).toBe(normalized)
    expect(store.getState().unreadTerminalPanes).toEqual(beforeUnread)
  })

  it('still deletes the layout on a clearing call, and bails when already absent', () => {
    const store = createTestStore()
    store.getState().setTabLayout('tab-1', makeLayout())

    store.getState().setTabLayout('tab-1', null)
    expect('tab-1' in store.getState().terminalLayoutsByTabId).toBe(false)

    let wakeups = 0
    const unsubscribe = store.subscribe(() => {
      wakeups += 1
    })
    store.getState().setTabLayout('tab-1', null)
    unsubscribe()
    expect(wakeups).toBe(0)
  })

  it('guards SSH acknowledgements by captured edit identity and target', () => {
    const store = createTestStore()
    const worktreeA = 'repo-a::/tmp/a'
    const worktreeB = 'repo-b::/tmp/b'
    store.setState({
      repos: [
        {
          id: 'repo-a',
          path: '/tmp',
          displayName: 'Repo A',
          badgeColor: '#000',
          addedAt: 0,
          connectionId: 'target-a'
        },
        {
          id: 'repo-b',
          path: '/tmp',
          displayName: 'Repo B',
          badgeColor: '#000',
          addedAt: 0,
          connectionId: 'target-b'
        }
      ],
      worktreesByRepo: {
        'repo-a': [makeWorktree({ id: worktreeA, repoId: 'repo-a', hostId: 'ssh:target-a' })],
        'repo-b': [makeWorktree({ id: worktreeB, repoId: 'repo-b', hostId: 'ssh:target-b' })]
      },
      tabsByWorktree: {
        [worktreeA]: [makeTab({ id: 'tab-a', worktreeId: worktreeA })],
        [worktreeB]: [makeTab({ id: 'tab-b', worktreeId: worktreeB })]
      }
    })
    const empty = { root: null, activeLeafId: null, expandedLeafId: null }

    store.getState().setTabLayout('tab-a', {
      ...empty,
      root: { type: 'leaf', leafId: 'leaf-initial' },
      activeLeafId: 'leaf-initial'
    })
    store.getState().setTabLayout('tab-a', empty)
    const firstEdit = store.getState().pendingDirectSshLayoutEditsByTabId['tab-a']
    store.getState().setTabLayout('tab-a', {
      ...empty,
      root: { type: 'leaf', leafId: 'leaf-a' },
      activeLeafId: 'leaf-a'
    })
    const currentEdit = store.getState().pendingDirectSshLayoutEditsByTabId['tab-a']
    expect(currentEdit).not.toBe(firstEdit)

    store.getState().acknowledgeDirectSshLayoutEdits({ 'tab-a': firstEdit })
    expect(store.getState().pendingDirectSshLayoutEditsByTabId['tab-a']).toBe(currentEdit)

    store.getState().setTabLayout('tab-b', {
      ...empty,
      root: { type: 'leaf', leafId: 'leaf-initial-b' },
      activeLeafId: 'leaf-initial-b'
    })
    store.getState().setTabLayout('tab-b', empty)
    const targetBEdit = store.getState().pendingDirectSshLayoutEditsByTabId['tab-b']
    store.getState().acknowledgeDirectSshLayoutEdits({ 'tab-a': currentEdit })
    expect(store.getState().pendingDirectSshLayoutEditsByTabId['tab-a']).toBeUndefined()
    expect(store.getState().pendingDirectSshLayoutEditsByTabId['tab-b']).toBe(targetBEdit)

    store.getState().acknowledgeDirectSshLayoutEdits({
      'tab-b': { targetId: 'target-a', root: targetBEdit.root }
    })
    expect(store.getState().pendingDirectSshLayoutEditsByTabId['tab-b']).toBe(targetBEdit)
  })
})
