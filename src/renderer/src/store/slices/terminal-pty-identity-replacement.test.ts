import { describe, expect, it } from 'vitest'
import { createTestStore, makeTab, seedStore } from './store-test-helpers'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'

{
  describe('terminal PTY identity replacement', () => {
    it('keeps repeated remote handle rotations bounded to the live identity', () => {
      const store = createTestStore()
      const worktreeId = 'repo1::/path/wt1'
      const firstPtyId = 'remote:env-1@@terminal-1'
      const secondPtyId = 'remote:env-1@@terminal-2'
      const thirdPtyId = 'remote:env-1@@terminal-3'
      seedStore(store, {
        tabsByWorktree: {
          [worktreeId]: [makeTab({ id: 'tab-1', worktreeId, ptyId: firstPtyId })]
        },
        ptyIdsByTabId: { 'tab-1': [firstPtyId] },
        suppressedPtyExitIds: { [firstPtyId]: true }
      })

      store.getState().updateTabPtyId('tab-1', secondPtyId, firstPtyId)
      store.getState().updateTabPtyId('tab-1', thirdPtyId, secondPtyId)

      const state = store.getState()
      expect(state.ptyIdsByTabId['tab-1']).toEqual([thirdPtyId])
      expect(state.tabsByWorktree[worktreeId][0]?.ptyId).toBe(thirdPtyId)
      expect(state.lastKnownRelayPtyIdByTabId['tab-1']).toBe(thirdPtyId)
      expect(state.suppressedPtyExitIds).toEqual({ [thirdPtyId]: true })
    })

    it('migrates stale PTY state when the host snapshot published the replacement first', () => {
      const store = createTestStore()
      const worktreeId = 'repo1::/path/wt1'
      const stalePtyId = 'remote:env-1@@terminal-stale'
      const replacementPtyId = 'remote:env-1@@terminal-replacement'
      seedStore(store, {
        tabsByWorktree: {
          [worktreeId]: [makeTab({ id: 'tab-1', worktreeId, ptyId: replacementPtyId })]
        },
        ptyIdsByTabId: { 'tab-1': [replacementPtyId] },
        pendingPaneAccountRestarts: { [stalePtyId]: 'codex' }
      })

      store.getState().updateTabPtyId('tab-1', replacementPtyId, stalePtyId)

      expect(store.getState().ptyIdsByTabId['tab-1']).toEqual([replacementPtyId])
      expect(store.getState().pendingPaneAccountRestarts).toEqual({ [replacementPtyId]: 'codex' })
    })

    it('publishes pane and tab replacement identities in one store commit', () => {
      const store = createTestStore()
      const worktreeId = 'repo1::/path/wt1'
      const stalePtyId = 'remote:env-1@@terminal-stale'
      const replacementPtyId = 'remote:env-1@@terminal-replacement'
      const tabId = 'tab-1'
      const leafId = 'pane:1'
      seedStore(store, {
        tabsByWorktree: {
          [worktreeId]: [makeTab({ id: tabId, worktreeId, ptyId: stalePtyId })]
        },
        ptyIdsByTabId: { [tabId]: [stalePtyId] },
        terminalLayoutsByTabId: {
          [tabId]: {
            root: { type: 'leaf', leafId },
            activeLeafId: leafId,
            expandedLeafId: null,
            ptyIdsByLeafId: { [leafId]: stalePtyId }
          }
        }
      })
      const observed: { tabPtyId: string | null; panePtyId: string | null }[] = []
      const unsubscribe = store.subscribe((state) => {
        observed.push({
          tabPtyId:
            state.tabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)?.ptyId ?? null,
          panePtyId: state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId] ?? null
        })
      })

      store.getState().updateTabPtyId(tabId, replacementPtyId, stalePtyId)
      unsubscribe()

      expect(observed).toEqual([{ tabPtyId: replacementPtyId, panePtyId: replacementPtyId }])
    })
  })
}

{
  /** Cache-timer/title churn repeats equal writes; subscriber-count assertions require no-op timer/layout updates to avoid O(panes) fanout (1,000 before, zero after). */

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
      // Duplicate-PTY normalization transfers ownership; replaying its normalized result must publish nothing.
      const store = createTestStore()
      const duplicate = makeLayout({
        ptyIdsByLeafId: { 'leaf-a': 'pty-a', 'leaf-b': 'pty-a' }
      })
      store.getState().setTabLayout('tab-1', duplicate)
      const normalized = store.getState().terminalLayoutsByTabId['tab-1']
      expect(normalized.ptyIdsByLeafId).not.toEqual(duplicate.ptyIdsByLeafId)

      store.setState({ unreadTerminalPanes: { 'tab-1:leaf-a': 'terminal-bell' } })
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
  })
}

{
  function terminalTab(id: string, worktreeId: string): TerminalTab {
    return {
      id,
      ptyId: null,
      worktreeId,
      title: 'Terminal 1',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    }
  }

  describe('pane foreground agent slice', () => {
    it('sets, value-bails, and clears entries per pane key', () => {
      const store = createTestStore()
      store
        .getState()
        .setPaneForegroundAgent('tab-1:leaf-1', { agent: 'aider', shellForeground: false })
      const first = store.getState().paneForegroundAgentByPaneKey

      store
        .getState()
        .setPaneForegroundAgent('tab-1:leaf-1', { agent: 'aider', shellForeground: false })
      expect(store.getState().paneForegroundAgentByPaneKey).toBe(first)

      store.getState().setPaneForegroundAgent('tab-1:leaf-1', {
        agent: 'aider',
        routingRevoked: true,
        routingConfirmationPending: true,
        shellForeground: false
      })
      expect(store.getState().paneForegroundAgentByPaneKey).not.toBe(first)
      expect(store.getState().paneForegroundAgentByPaneKey['tab-1:leaf-1']?.routingRevoked).toBe(
        true
      )
      expect(
        store.getState().paneForegroundAgentByPaneKey['tab-1:leaf-1']?.routingConfirmationPending
      ).toBe(true)

      store.getState().clearPaneForegroundAgent('tab-1:leaf-1')
      expect(store.getState().paneForegroundAgentByPaneKey).toEqual({})
    })

    // Confirmation settle can change only routingConfirmationPending; equality must allow clearing it or CSI-u stays enabled.
    it('lands the publish that clears a pending confirmation', () => {
      const store = createTestStore()
      store.getState().setPaneForegroundAgent('tab-1:leaf-1', {
        agent: 'pi',
        routingRevoked: true,
        routingConfirmationPending: true,
        shellForeground: false
      })

      // Exactly the entry the inconclusive-settle path republishes.
      store.getState().setPaneForegroundAgent('tab-1:leaf-1', {
        agent: 'pi',
        routingRevoked: true,
        shellForeground: false
      })

      expect(store.getState().paneForegroundAgentByPaneKey['tab-1:leaf-1']).toEqual({
        agent: 'pi',
        routingRevoked: true,
        shellForeground: false
      })
    })

    // Same-agent confirmation must still replace launch-only evidence so sidebar recognizes process-backed identity.
    it('lands a process read that confirms a launch-record agent', () => {
      const store = createTestStore()
      store.getState().setPaneForegroundAgent('tab-1:leaf-1', {
        agent: 'codex',
        agentEvidence: 'launch-record',
        shellForeground: false
      })
      store.getState().setPaneForegroundAgent('tab-1:leaf-1', {
        agent: 'codex',
        agentEvidence: 'process-read',
        shellForeground: false
      })

      expect(store.getState().paneForegroundAgentByPaneKey['tab-1:leaf-1']?.agentEvidence).toBe(
        'process-read'
      )
    })

    it('sweeps only the closed tab prefix, not sibling tabs or prefix-share ids', () => {
      const store = createTestStore()
      store
        .getState()
        .setPaneForegroundAgent('tab-1:leaf-1', { agent: 'aider', shellForeground: false })
      store
        .getState()
        .setPaneForegroundAgent('tab-10:leaf-1', { agent: 'codex', shellForeground: false })

      store.getState().clearPaneForegroundAgentByTabPrefix('tab-1')

      expect(Object.keys(store.getState().paneForegroundAgentByPaneKey)).toEqual(['tab-10:leaf-1'])
    })

    it('sweeps every tab of a worktree on wholesale teardown', () => {
      const store = createTestStore()
      store.setState({
        tabsByWorktree: {
          'wt-1': [terminalTab('tab-1', 'wt-1'), terminalTab('tab-2', 'wt-1')],
          'wt-2': [terminalTab('tab-3', 'wt-2')]
        }
      })
      store
        .getState()
        .setPaneForegroundAgent('tab-1:leaf-1', { agent: 'aider', shellForeground: false })
      store
        .getState()
        .setPaneForegroundAgent('tab-2:leaf-1', { agent: null, shellForeground: true })
      store
        .getState()
        .setPaneForegroundAgent('tab-3:leaf-1', { agent: 'codex', shellForeground: false })

      const before = store.getState().paneForegroundAgentByPaneKey
      store.getState().clearPaneForegroundAgentByWorktree('wt-missing')
      expect(store.getState().paneForegroundAgentByPaneKey).toBe(before)

      store.getState().clearPaneForegroundAgentByWorktree('wt-1')

      expect(Object.keys(store.getState().paneForegroundAgentByPaneKey)).toEqual(['tab-3:leaf-1'])
    })
  })
}
