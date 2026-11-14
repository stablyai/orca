import { afterEach, expect, it, vi } from 'vitest'
import { createTestStore } from '../../testing/app-store-test-fixture'
import { readRecordChanges } from '../../keyed-record-change-reads'
import * as transitions from '../../keyed-record-transitions'
import type { AgentPaneConversationIdentity } from './agent-pane-conversation'
import type { AgentStatusUpdate } from './agent-status-contract'
import { applyWebSessionTabsSnapshot } from '@/runtime/web-session-tabs-sync/snapshot-api'
import {
  ENV,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState,
  WT,
  LEAF_ID
} from '@/runtime/web-session-tabs-sync/testing/web-session-tabs-sync.test-fixture'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'

const actualDraft = transitions.recordDraft

afterEach(() => {
  resetWebSessionTabsSyncTestState()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function countProvenance(source: Readonly<Record<string, AgentPaneConversationIdentity>>) {
  let materialized = 0
  const seen = new WeakSet<readonly string[]>()
  function countedDraft<V>(previous: Readonly<Record<string, V>>): transitions.RecordDraft<V> {
    const draft = actualDraft(previous)
    if (previous !== source) {
      return draft
    }
    return {
      ...draft,
      finish: () => {
        const result = draft.finish()
        const link = transitions.linkOf(result)
        if (link && 'keys' in link && !seen.has(link.keys)) {
          seen.add(link.keys)
          materialized += link.keys.length
        }
        return result
      }
    }
  }
  vi.spyOn(transitions, 'recordDraft').mockImplementation(countedDraft)
  return () => materialized
}

function snapshot(rows: AgentStatusEntry[], version: number) {
  return makeSnapshot(
    rows.map((entry) => ({
      type: 'terminal' as const,
      id: `${entry.tabId}::${LEAF_ID}`,
      parentTabId: entry.tabId!,
      leafId: LEAF_ID,
      title: 'Codex',
      isActive: false,
      status: 'ready' as const,
      terminal: `terminal-${entry.tabId}`,
      agentStatus: entry
    })),
    { snapshotVersion: version }
  )
}

it.each([100, 1000])(
  'finalizes local conversation provenance linearly for %s changed panes',
  (count) => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const store = createTestStore()
    store.setState({
      terminalLayoutsByTabId: Object.fromEntries(
        Array.from({ length: count }, (_, i) => [
          `batch-${i}`,
          {
            root: { type: 'leaf' as const, leafId: LEAF_ID },
            activeLeafId: LEAF_ID,
            expandedLeafId: null
          }
        ])
      )
    })
    const updates = (state: 'working' | 'done', at: number): AgentStatusUpdate[] =>
      Array.from({ length: count }, (_, i) => ({
        paneKey: `batch-${i}:${LEAF_ID}`,
        payload: { state, prompt: 'task', agentType: 'codex' },
        timing: { updatedAt: at, stateStartedAt: at, turnStartedAt: 1000 },
        routing: { tabId: `batch-${i}`, worktreeId: WT }
      }))
    store.getState().setAgentStatuses(updates('working', 1000))
    const original = store.getState().agentConversationsByPaneKey
    const work = countProvenance(original)
    store.getState().setAgentStatuses(updates('done', 3000))
    expect(
      store.getState().agentConversationsByPaneKey[`batch-${count - 1}:${LEAF_ID}`].continuity
        ?.state
    ).toBe('done')
    expect(readRecordChanges(store.getState().agentConversationsByPaneKey, original)).toMatchObject(
      {
        kind: 'addressed',
        keys: new Set(Array.from({ length: count }, (_, i) => `batch-${i}:${LEAF_ID}`)),
        added: [],
        deleted: new Set()
      }
    )
    // One complete provenance list is required for one atomic publication, independent of batch size.
    expect(work()).toBe(count === 100 ? 100 : 1000)
  }
)

it.each([100, 1000])(
  'finalizes paired conversation provenance linearly for %s changed panes',
  (count) => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const rows = (state: 'working' | 'done', at: number): AgentStatusEntry[] =>
      Array.from({ length: count }, (_, i) => ({
        paneKey: `batch-${i}:${LEAF_ID}`,
        tabId: `batch-${i}`,
        worktreeId: WT,
        agentType: 'codex',
        state,
        prompt: 'task',
        updatedAt: at,
        stateStartedAt: at,
        firstStateStartedAt: 1000,
        turnStartedAt: 1000,
        stateHistory: []
      }))
    const initial = makeState()
    const before = {
      ...initial,
      ...applyWebSessionTabsSnapshot(initial, snapshot(rows('working', 1000), 1), ENV, 1000)
    }
    const work = countProvenance(before.agentConversationsByPaneKey!)
    const after = {
      ...before,
      ...applyWebSessionTabsSnapshot(before, snapshot(rows('done', 3000), 2), ENV, 3000)
    }
    expect(
      readRecordChanges(after.agentConversationsByPaneKey!, before.agentConversationsByPaneKey!)
    ).toMatchObject({
      kind: 'addressed',
      keys: new Set(Array.from({ length: count }, (_, i) => `web-terminal-batch-${i}:${LEAF_ID}`)),
      added: [],
      deleted: new Set()
    })
    expect(
      after.agentConversationsByPaneKey?.[`web-terminal-batch-${count - 1}:${LEAF_ID}`].continuity
        ?.state
    ).toBe('done')
    expect(work()).toBe(count === 100 ? 100 : 1000)
  }
)

it('keeps complete provenance across an interleaved writer and discards an aborted draft', () => {
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
  const store = createTestStore()
  const update = (id: string, state: 'working' | 'done', at: number): AgentStatusUpdate => ({
    paneKey: `${id}:${LEAF_ID}`,
    payload: { state, prompt: 'task', agentType: 'codex' },
    timing: { updatedAt: at, stateStartedAt: at, turnStartedAt: 1000 },
    routing: { tabId: id, worktreeId: WT }
  })
  store
    .getState()
    .setAgentStatuses(['first', 'removed', 'last'].map((id) => update(id, 'working', 1000)))
  const original = store.getState().agentConversationsByPaneKey
  store.getState().transactAgentStatuses((transaction) => {
    transaction.apply({ kind: 'status', ...update('first', 'done', 3000) })
    store.getState().updateAgentStatusState((state) => ({
      agentConversationsByPaneKey: transitions.replaceRecordEntries<AgentPaneConversationIdentity>(
        state.agentConversationsByPaneKey,
        [[`removed:${LEAF_ID}`, null]]
      )
    }))
    transaction.apply({ kind: 'status', ...update('last', 'done', 3000) })
  })
  const accepted = store.getState().agentConversationsByPaneKey
  expect(accepted[`first:${LEAF_ID}`].continuity?.state).toBe('done')
  expect(accepted[`last:${LEAF_ID}`].continuity?.state).toBe('done')
  expect(accepted[`removed:${LEAF_ID}`]).toBeUndefined()
  expect(readRecordChanges(accepted, original)).toEqual({
    kind: 'addressed',
    keys: new Set([`first:${LEAF_ID}`, `removed:${LEAF_ID}`, `last:${LEAF_ID}`]),
    added: [],
    deleted: new Set([`removed:${LEAF_ID}`])
  })
  expect(() =>
    store.getState().transactAgentStatuses((transaction) => {
      transaction.apply({ kind: 'status', ...update('first', 'working', 5000) })
      throw new Error('abort')
    })
  ).toThrow('abort')
  expect(store.getState().agentConversationsByPaneKey).toBe(accepted)
  store.getState().setAgentStatuses([update('first', 'working', 5000)])
  expect(store.getState().agentConversationsByPaneKey[`first:${LEAF_ID}`].continuity?.state).toBe(
    'working'
  )
})
