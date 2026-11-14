import { expect, it } from 'vitest'
import { createTestStore } from '../../testing/app-store-test-fixture'
import { replaceRecordEntries } from '../../keyed-record-transitions'
import type { AppState } from '../../types'
import type { AgentPaneConversationIdentity } from './agent-pane-conversation'
import type { AgentStatusUpdate } from './agent-status-contract'
import { makeTab } from '../../terminals/testing/terminal-tab.test-fixture'

function conversation(key: string): AgentPaneConversationIdentity {
  return {
    paneKey: key,
    worktreeId: 'wt-order',
    executionHostId: 'local',
    connectionId: null,
    agent: 'codex'
  }
}
const layout = (root: AppState['terminalLayoutsByTabId'][string]['root']) => ({
  root,
  activeLeafId: 'leaf',
  expandedLeafId: null
})

it.each([100, 1000])(
  'addresses capacity work across %s workspaces with placed owners above 500',
  (size) => {
    const store = createTestStore()
    const visits: string[] = []
    const roots: string[] = []
    const leaf = (id: string, leafId = 'leaf') => ({
      get type() {
        visits.push(id)
        return 'leaf' as const
      },
      leafId
    })
    const layouts = Object.fromEntries(
      Array.from({ length: size * 10 }, (_, i) => [`tab-${i}`, layout(leaf(`tab-${i}`))])
    )
    for (const [id, snapshot] of Object.entries(layouts)) {
      const root = snapshot.root
      Object.defineProperty(snapshot, 'root', {
        enumerable: true,
        get: () => {
          roots.push(id)
          return root
        }
      })
    }
    const entries = Object.fromEntries(
      Array.from({ length: size * 6 }, (_, i) => [`tab-${i}:leaf`, conversation(`tab-${i}:leaf`)])
    )
    store.setState({
      terminalLayoutsByTabId: layouts,
      agentConversationsByPaneKey: entries,
      tabsByWorktree: {
        'wt-order': Object.keys(layouts).map((id) => makeTab({ id, worktreeId: 'wt-order' }))
      }
    })
    const update = (index: number, state: 'working' | 'done', at: number): AgentStatusUpdate => ({
      paneKey: `tab-${index}:leaf`,
      payload: { state, prompt: 'task', agentType: 'codex' },
      timing: { updatedAt: at, stateStartedAt: at, turnStartedAt: 1000 },
      routing: { worktreeId: 'wt-order' }
    })
    store
      .getState()
      .setAgentStatuses(Array.from({ length: 100 }, (_, i) => update(i, 'working', 1000)))
    const unrelatedRoot = layouts[`tab-${size * 10 - 1}`].root
    visits.length = 0
    roots.length = 0
    const original = store.getState().agentConversationsByPaneKey
    store.getState().setAgentStatuses([update(0, 'working', 2000)])
    expect(store.getState().agentConversationsByPaneKey).toBe(original)
    store.getState().setAgentStatuses([update(0, 'done', 3000)])
    expect(store.getState().agentConversationsByPaneKey['tab-0:leaf'].continuity?.state).toBe(
      'done'
    )
    store
      .getState()
      .setAgentStatuses([update(1, 'done', 4000), update(2, 'done', 4000), update(3, 'done', 4000)])
    const unrelated = `tab-${size * 10 - 1}`
    store.setState((state) => ({
      terminalLayoutsByTabId: replaceRecordEntries<AppState['terminalLayoutsByTabId'][string]>(
        state.terminalLayoutsByTabId,
        [
          [
            unrelated,
            { ...layout(unrelatedRoot), activeLeafId: null, ptyIdsByLeafId: { leaf: 'pty' } }
          ],
          ['empty-tab', layout(null)]
        ]
      )
    }))
    expect(visits).toEqual([])
    expect(roots).toEqual([])
    const freshRoot = leaf('fresh-tab')
    const freshLayout = layout(freshRoot)
    Object.defineProperty(freshLayout, 'root', {
      enumerable: true,
      get: () => {
        roots.push('fresh-tab')
        return freshRoot
      }
    })
    store.setState((state) => ({
      terminalLayoutsByTabId: replaceRecordEntries<AppState['terminalLayoutsByTabId'][string]>(
        state.terminalLayoutsByTabId,
        [['fresh-tab', freshLayout]]
      )
    }))
    expect(visits).toEqual([])
    store
      .getState()
      .setAgentStatuses([{ ...update(0, 'working', 5000), paneKey: 'fresh-tab:leaf' }])
    expect(visits).toEqual(['fresh-tab'])
    expect(roots).toEqual(['fresh-tab'])
    expect(store.getState().agentConversationsByPaneKey['fresh-tab:leaf']).toBeDefined()
    visits.length = 0
    roots.length = 0
    store
      .getState()
      .closeTab('tab-0', { localPtyTeardownOwnedExternally: true, captureRecentlyClosed: false })
    expect(store.getState().agentConversationsByPaneKey['tab-0:leaf']).toBeUndefined()
    expect(store.getState().agentConversationsByPaneKey['tab-1:leaf']).toBeDefined()
    expect(visits.filter((id) => id !== 'tab-0')).toEqual([])
    expect(roots.filter((id) => id !== 'tab-0')).toEqual([])
  }
)

it('enforces oldest-unplaced order on demotion, restoration and unknown replacement', () => {
  const store = createTestStore()
  const placed = 'old:leaf'
  const entries = Object.fromEntries(
    [placed, ...Array.from({ length: 500 }, (_, i) => `gone-${i}:leaf`)].map((key) => [
      key,
      conversation(key)
    ])
  )
  store.setState({
    terminalLayoutsByTabId: { old: layout({ type: 'leaf', leafId: 'leaf' }) },
    agentConversationsByPaneKey: entries
  })
  expect(Object.keys(store.getState().agentConversationsByPaneKey)).toHaveLength(501)
  // A value replacement never refreshes the oldest key's eviction rank.
  store.setState((state) => ({
    agentConversationsByPaneKey: replaceRecordEntries<AgentPaneConversationIdentity>(
      state.agentConversationsByPaneKey,
      [[placed, { ...entries[placed], firstStateStartedAt: 42 }]]
    )
  }))
  store.getState().setTabLayout('old', layout({ type: 'leaf', leafId: 'sibling' }))
  expect(store.getState().agentConversationsByPaneKey[placed]).toBeUndefined()
  expect(Object.keys(store.getState().agentConversationsByPaneKey)).toHaveLength(500)
  store.getState().setTabLayout('gone-0', layout({ type: 'leaf', leafId: 'leaf' }))
  store.setState((state) => ({
    agentConversationsByPaneKey: replaceRecordEntries<AgentPaneConversationIdentity>(
      state.agentConversationsByPaneKey,
      [['extra:leaf', conversation('extra:leaf')]]
    )
  }))
  expect(store.getState().agentConversationsByPaneKey['gone-0:leaf']).toBeDefined()
  expect(store.getState().agentConversationsByPaneKey['gone-1:leaf']).toBeDefined()
  // Unknown reordering retains surviving order, rather than refreshing all old keys.
  store.setState((state) => ({
    agentConversationsByPaneKey: Object.fromEntries(
      Object.entries(state.agentConversationsByPaneKey).toReversed()
    )
  }))
  store.getState().setTabLayout('gone-0', null)
  expect(store.getState().agentConversationsByPaneKey['gone-0:leaf']).toBeUndefined()
  expect(store.getState().agentConversationsByPaneKey['gone-1:leaf']).toBeDefined()
  expect(store.getState().agentConversationsByPaneKey['extra:leaf']).toBeDefined()
})

it('preserves exact legacy full-key placement and bounds rootless or missing leaves on hydrate', () => {
  const store = createTestStore()
  const cold = {
    get type(): 'leaf' {
      throw new Error('unrelated tree visited')
    },
    leafId: 'unused'
  }
  const legacy = 'host:tab:leaf'
  const rootless = 'rootless:leaf'
  const missing = 'rooted:missing'
  const keys = [
    legacy,
    rootless,
    missing,
    ...Array.from({ length: 501 }, (_, i) => `absent-${i}:leaf`)
  ]
  store.setState({
    terminalLayoutsByTabId: {
      'host:tab': layout({ type: 'leaf', leafId: 'leaf' }),
      rootless: layout(null),
      rooted: layout({ type: 'leaf', leafId: 'sibling' }),
      unrelated: layout(cold)
    },
    agentConversationsByPaneKey: Object.fromEntries(keys.map((key) => [key, conversation(key)]))
  })
  expect(Object.keys(store.getState().agentConversationsByPaneKey)).toHaveLength(501)
  expect(store.getState().agentConversationsByPaneKey[legacy]).toBeDefined()
  expect(store.getState().agentConversationsByPaneKey[rootless]).toBeUndefined()
  expect(store.getState().agentConversationsByPaneKey[missing]).toBeUndefined()
  expect(store.getState().agentConversationsByPaneKey['absent-0:leaf']).toBeUndefined()
  store.getState().setTabLayout('host:tab', null)
  expect(store.getState().agentConversationsByPaneKey[legacy]).toBeUndefined()
  expect(Object.keys(store.getState().agentConversationsByPaneKey)).toHaveLength(500)
})

it('appends a new integer-shaped key for eviction, then follows record ordering on later writes', () => {
  const store = createTestStore()
  const keys = Array.from({ length: 500 }, (_, i) => `gone-${i}:leaf`)
  store.setState({
    agentConversationsByPaneKey: Object.fromEntries(keys.map((key) => [key, conversation(key)]))
  })
  store.setState((state) => ({
    agentConversationsByPaneKey: replaceRecordEntries(state.agentConversationsByPaneKey, [
      ['1', conversation('1')]
    ])
  }))
  expect(store.getState().agentConversationsByPaneKey['gone-0:leaf']).toBeUndefined()
  expect(store.getState().agentConversationsByPaneKey['1']).toBeDefined()
  store.setState((state) => ({
    agentConversationsByPaneKey: replaceRecordEntries(state.agentConversationsByPaneKey, [
      ['last:leaf', conversation('last:leaf')]
    ])
  }))
  expect(store.getState().agentConversationsByPaneKey['1']).toBeUndefined()
  expect(store.getState().agentConversationsByPaneKey['gone-1:leaf']).toBeDefined()
})
