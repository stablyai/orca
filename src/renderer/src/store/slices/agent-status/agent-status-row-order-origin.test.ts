import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetAgentPaneAuthorityAliasesForTests } from './agent-pane-authority'
import { wslHookRelayConnectionId } from '../../../../../shared/wsl-hook-relay-contract'
import { createTestStore } from '../../testing/app-store-test-fixture'
import { buildWorktreeAgentRows } from '@/components/sidebar/workspace-card/activity/worktree-agent-rows'
import { AGENT_STATE_HISTORY_MAX } from '../../../../../shared/agent-status/lifecycle/agent-state-history'
import { makePaneKey, parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import type { AgentStatusTiming, AgentStatusUpdate } from './agent-status-contract'
import { applyWebSessionTabsSnapshot } from '@/runtime/web-session-tabs-sync/snapshot-api'
import {
  ENV,
  makeSnapshot,
  makeState
} from '@/runtime/web-session-tabs-sync/testing/web-session-tabs-sync.test-fixture'

const pane = makePaneKey('tab-order', '11111111-1111-4111-8111-111111111111')
const quiet = makePaneKey('tab-quiet', '22222222-2222-4222-8222-222222222222')
afterEach(() => {
  vi.useRealTimers()
  resetAgentPaneAuthorityAliasesForTests()
})

function fixture(agentType = 'pi') {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  const store = createTestStore()
  const write = (
    at: number,
    state: 'working' | 'done',
    session?: string,
    timing: Omit<AgentStatusTiming, 'updatedAt'> = {}
  ) =>
    store
      .getState()
      .setAgentStatus(
        pane,
        { state, prompt: 'task', agentType },
        undefined,
        { ...timing, updatedAt: at },
        { worktreeId: 'wt-order' },
        session ? { providerSession: { key: 'session_id', id: session } } : undefined
      )
  const rows = () =>
    buildWorktreeAgentRows({
      tabs: [],
      entries: Array.from(store.getState().agentStatusByPaneKey.values()),
      now: 1_000_000
    })
  return { store, write, rows }
}

describe('observed agent session row origin', () => {
  it('carries a source-dated replacement from local status through paired row projection', () => {
    const { store, write, rows } = fixture('claude')
    let client = makeState()
    const publish = (version: number) => {
      const tabs = Array.from(store.getState().agentStatusByPaneKey.values()).map((entry) => {
        const parsed = parsePaneKey(entry.paneKey)
        if (!parsed) {
          throw new Error('Expected a terminal pane key')
        }
        return {
          type: 'terminal' as const,
          id: `${parsed.tabId}::${parsed.leafId}`,
          title: 'Claude',
          parentTabId: parsed.tabId,
          leafId: parsed.leafId,
          isActive: entry.paneKey === pane,
          status: 'ready' as const,
          terminal: `terminal-${parsed.tabId}`,
          agentStatus: entry
        }
      })
      client = {
        ...client,
        ...applyWebSessionTabsSnapshot(
          client,
          makeSnapshot(tabs, { worktree: 'wt-order', snapshotVersion: version }),
          ENV,
          1_000_000 + version
        )
      }
      return buildWorktreeAgentRows({
        tabs: client.tabsByWorktree['wt-order'] ?? [],
        entries: Array.from(client.agentStatusByPaneKey.values()),
        now: 1_000_000 + version
      })
    }
    write(1000, 'working', 'A', { turnStartedAt: 1000 })
    store
      .getState()
      .setAgentStatus(
        quiet,
        { state: 'working', prompt: '', agentType: 'claude' },
        undefined,
        { updatedAt: 2000 },
        { worktreeId: 'wt-order' },
        { providerSession: { key: 'session_id', id: 'quiet' } }
      )
    expect(publish(1).map((row) => row.entry.providerSession?.id)).toEqual(['A', 'quiet'])
    write(7000, 'working', 'B', {
      stateStartedAt: 1000,
      turnStartedAt: 1000,
      evidenceObservedAt: 6000
    })
    expect(store.getState().agentStatusByPaneKey.get(pane)).toMatchObject({
      stateStartedAt: 1000,
      firstStateStartedAt: 6000,
      updatedAt: 7000,
      evidenceObservedAt: 6000
    })
    expect(rows().map((row) => row.entry.providerSession?.id)).toEqual(['quiet', 'B'])
    const mirrored = publish(2)
    expect(mirrored.map((row) => row.entry.providerSession?.id)).toEqual(['quiet', 'B'])
    expect(mirrored[1].entry).toMatchObject({ stateStartedAt: 1000, firstStateStartedAt: 6000 })
  })

  it.each(['pi', 'claude', 'codex'])(
    'keeps %s rows ordered after the recent-history cap',
    (agent) => {
      const { store, write, rows } = fixture(agent)
      write(1000, 'working', 'same-session')
      store
        .getState()
        .setAgentStatus(
          quiet,
          { state: 'working', prompt: '', agentType: agent },
          undefined,
          { updatedAt: 2000 },
          { worktreeId: 'wt-order' }
        )
      const before = rows().map((row) => row.paneKey)
      for (let i = 0; i < AGENT_STATE_HISTORY_MAX + 2; i++) {
        write(3000 + i * 1000, i % 2 ? 'working' : 'done', 'same-session')
      }
      expect(
        store.getState().agentStatusByPaneKey.get(pane)!.stateHistory[0].startedAt
      ).toBeGreaterThan(2000)
      expect(rows().map((row) => row.paneKey)).toEqual(before)
    }
  )
})

it('preserves origin through routing enrichment, WSL equivalence and pane transfer', () => {
  const { store, write, rows } = fixture('claude')
  write(1000, 'working', 'A')
  const workspace = String.raw`repo::\\wsl.localhost\Ubuntu\home\user\repo`
  store
    .getState()
    .setAgentStatus(
      pane,
      { state: 'working', prompt: 'task', agentType: 'claude' },
      undefined,
      { updatedAt: 2000 },
      { worktreeId: workspace, connectionId: null }
    )
  expect(rows()[0].startedAt).toBe(2000)
  store
    .getState()
    .setAgentStatus(
      pane,
      { state: 'working', prompt: 'task', agentType: 'claude' },
      undefined,
      { updatedAt: 3000 },
      { connectionId: wslHookRelayConnectionId('Ubuntu'), worktreeId: workspace }
    )
  expect(rows()[0].startedAt).toBe(2000)
  const transferred = makePaneKey('tab-transfer', '33333333-3333-4333-8333-333333333333')
  store.getState().transferAgentPaneAuthority({ fromPaneKey: pane, toPaneKey: transferred })
  expect(rows()[0].startedAt).toBe(2000)
  expect(rows()[0].paneKey).toBe(transferred)
  store
    .getState()
    .setAgentStatus(
      transferred,
      { state: 'working', prompt: 'task', agentType: 'claude' },
      undefined,
      { updatedAt: 4000 },
      { connectionId: 'different-host', worktreeId: workspace }
    )
  expect(rows()[0].startedAt).toBe(4000)
})

it('keeps the first session clock across transient SSH loss and provider-less replay', () => {
  const store = createTestStore()
  const publish = (at: number, state: 'working' | 'done', session?: string) =>
    store
      .getState()
      .setAgentStatus(
        pane,
        { state, prompt: 'task', agentType: 'claude' },
        undefined,
        { updatedAt: at, stateStartedAt: at },
        { worktreeId: 'wt-order', connectionId: 'ssh-a' },
        session ? { providerSession: { key: 'session_id', id: session } } : undefined
      )
  publish(1000, 'working', 'A')
  publish(5000, 'done', 'A')
  store.getState().removeAgentStatus(pane)
  publish(6000, 'done')
  expect(store.getState().agentStatusByPaneKey.get(pane)!.firstStateStartedAt).toBe(1000)
  expect(store.getState().agentConversationsByPaneKey[pane].providerSession?.id).toBe('A')
  const conversations = store.getState().agentConversationsByPaneKey
  publish(7000, 'done', 'A')
  expect(store.getState().agentStatusByPaneKey.get(pane)!.firstStateStartedAt).toBe(1000)
  expect(store.getState().agentConversationsByPaneKey).toBe(conversations)
  store.getState().removeAgentStatus(pane)
  publish(8000, 'working', 'B')
  expect(store.getState().agentStatusByPaneKey.get(pane)!.firstStateStartedAt).toBe(8000)
})

it.each([false, true])(
  'keeps a paired host session clock through omission and stale replay (stamped: %s)',
  (stamped) => {
    let client = makeState()
    const publish = (version: number, at: number, state: 'working' | 'done', session?: string) => {
      client = {
        ...client,
        ...applyWebSessionTabsSnapshot(
          client,
          makeSnapshot(
            [
              {
                type: 'terminal',
                id: `tab-order::11111111-1111-4111-8111-111111111111`,
                title: 'Claude',
                parentTabId: 'tab-order',
                leafId: '11111111-1111-4111-8111-111111111111',
                isActive: true,
                status: 'ready',
                terminal: 'terminal-order',
                agentStatus: {
                  paneKey: pane,
                  tabId: 'tab-order',
                  worktreeId: 'wt-order',
                  agentType: 'claude',
                  state,
                  prompt: 'task',
                  updatedAt: at,
                  stateStartedAt: stamped && at === 7500 ? 1000 : at,
                  ...(stamped
                    ? {
                        observation: {
                          origin: 'hook' as const,
                          authorityId: 'H',
                          incarnation: 0,
                          revision: version,
                          observedAt: at,
                          kind: 'snapshot' as const
                        },
                        ...(at < 8000 ? { turnStartedAt: 1000 } : {})
                      }
                    : {}),
                  stateHistory: [],
                  ...(session
                    ? { providerSession: { key: 'session_id' as const, id: session } }
                    : {})
                }
              }
            ],
            { worktree: 'wt-order', snapshotVersion: version }
          ),
          ENV,
          1_000_000 + version
        )
      }
      return Array.from(client.agentStatusByPaneKey.values())[0]
    }
    const initial = publish(1, 1000, 'working', 'A')
    expect(initial.firstStateStartedAt).toBe(1000)
    expect(publish(2, 5000, 'done', 'A').firstStateStartedAt).toBe(1000)
    client = { ...client, agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({})) }
    expect(publish(3, 6000, 'done').firstStateStartedAt).toBe(1000)
    expect(client.agentConversationsByPaneKey?.[initial.paneKey].providerSession?.id).toBe('A')
    const conversations = client.agentConversationsByPaneKey
    publish(4, 7000, 'done', 'A')
    expect(client.agentConversationsByPaneKey).toBe(conversations)
    client = { ...client, agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({})) }
    if (stamped) {
      publish(5, 7500, 'working')
      client = { ...client, agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({})) }
    }
    expect(publish(6, 8000, 'working').firstStateStartedAt).toBe(8000)
    expect(client.agentConversationsByPaneKey?.[initial.paneKey].providerSession).toBeUndefined()
    expect(publish(7, 9000, 'working', 'B').firstStateStartedAt).toBe(8000)
  }
)

it('does not give an unidentified successor the previous conversation clock or prompt', () => {
  const { store, write } = fixture('codex')
  write(1000, 'working', 'A', { stateStartedAt: 1000, turnStartedAt: 1000 })
  write(5000, 'done', 'A', { stateStartedAt: 5000, turnStartedAt: 1000 })
  store.getState().removeAgentStatus(pane)
  store
    .getState()
    .setAgentStatus(
      pane,
      { state: 'working', prompt: 'next task', agentType: 'codex' },
      undefined,
      { updatedAt: 8000, stateStartedAt: 8000, turnStartedAt: 8000 },
      { worktreeId: 'wt-order' }
    )
  expect(store.getState().agentStatusByPaneKey.get(pane)!.firstStateStartedAt).toBe(8000)
  expect(store.getState().agentConversationsByPaneKey[pane].providerSession).toBeUndefined()
  expect(store.getState().agentConversationsByPaneKey[pane].promptCandidates).toEqual(['next task'])
})

it('keeps identity through stale phase replay and equal pings, but follows explicit new turn evidence', () => {
  const { store, write } = fixture('claude')
  write(1000, 'working', 'A', { stateStartedAt: 1000, turnStartedAt: 1000 })
  write(5000, 'done', 'A', { stateStartedAt: 5000, turnStartedAt: 1000 })
  store.getState().removeAgentStatus(pane)
  write(6000, 'working', undefined, { isReplay: true, stateStartedAt: 1000, turnStartedAt: 1000 })
  expect(store.getState().agentConversationsByPaneKey[pane].providerSession?.id).toBe('A')
  expect(store.getState().agentStatusByPaneKey.get(pane)!.firstStateStartedAt).toBe(1000)
  const previous = store.getState().agentConversationsByPaneKey
  write(6500, 'working', undefined, { isReplay: true, stateStartedAt: 1000, turnStartedAt: 1000 })
  expect(store.getState().agentConversationsByPaneKey).toBe(previous)
  store.getState().recordAgentProviderSession(pane, 'claude', { key: 'session_id', id: 'A' })
  expect(store.getState().agentConversationsByPaneKey).toBe(previous)
  write(8000, 'working', 'A', { stateStartedAt: 8000, turnStartedAt: 8000 })
  expect(store.getState().agentStatusByPaneKey.get(pane)!.firstStateStartedAt).toBe(1000)
  store.getState().removeAgentStatus(pane)
  write(10000, 'working', undefined, { isReplay: true, stateStartedAt: 8000, turnStartedAt: 10000 })
  expect(store.getState().agentConversationsByPaneKey[pane].providerSession).toBeUndefined()
  expect(store.getState().agentStatusByPaneKey.get(pane)!.firstStateStartedAt).toBe(10000)
})

it('keeps displaced prompt candidates out when an older phase is replayed', () => {
  const store = createTestStore()
  const publish = (state: 'working' | 'done', prompt: string, at: number, phase: number) =>
    store
      .getState()
      .setAgentStatus(
        pane,
        { state, prompt, agentType: 'codex' },
        undefined,
        { updatedAt: at, stateStartedAt: phase, isReplay: true },
        { worktreeId: 'wt-order' }
      )
  publish('done', 'old task', 1000, 1000)
  store.getState().removeAgentStatus(pane)
  publish('working', 'current task', 2000, 2000)
  publish('done', 'current task', 3000, 3000)
  store.getState().removeAgentStatus(pane)
  publish('working', 'old task', 4000, 1000)
  store.getState().removeAgentStatus(pane)
  expect(store.getState().agentConversationsByPaneKey[pane].promptCandidates).toEqual([
    'current task'
  ])
})

it('uses a newer incarnation even when it reuses the previous turn clock', () => {
  const store = createTestStore()
  const publish = (incarnation: number, session?: string) =>
    store.getState().setAgentStatus(
      pane,
      {
        state: 'working',
        prompt: 'task',
        agentType: 'codex',
        observation: {
          origin: 'hook',
          authorityId: 'host',
          incarnation,
          revision: incarnation + 1,
          observedAt: 1000 + incarnation
        }
      },
      undefined,
      { updatedAt: 1000 + incarnation, turnStartedAt: 1000 },
      { worktreeId: 'wt-order' },
      session ? { providerSession: { key: 'session_id', id: session } } : undefined
    )
  publish(0, 'A')
  store.getState().removeAgentStatus(pane)
  publish(1)
  expect(store.getState().agentConversationsByPaneKey[pane].providerSession).toBeUndefined()
})

it('keeps Command Code prompt boundaries case-sensitive after live removal', () => {
  const store = createTestStore()
  store
    .getState()
    .setAgentStatus(
      pane,
      { state: 'working', prompt: 'Task', agentType: 'command-code' },
      undefined,
      { updatedAt: 1000 },
      { worktreeId: 'wt-order' },
      { providerSession: { key: 'session_id', id: 'A' } }
    )
  store.getState().removeAgentStatus(pane)
  store
    .getState()
    .setAgentStatus(
      pane,
      { state: 'working', prompt: 'task', agentType: 'command-code' },
      undefined,
      { updatedAt: 2000 },
      { worktreeId: 'wt-order' }
    )
  expect(store.getState().agentConversationsByPaneKey[pane].providerSession).toBeUndefined()
  expect(store.getState().agentStatusByPaneKey.get(pane)!.firstStateStartedAt).toBe(2000)
})

it.each([100, 1000])('keeps conversation updates atomic with %s unplaced conversations', (size) => {
  const store = createTestStore()
  const update = (index: number, state: 'working' | 'done', at: number): AgentStatusUpdate => ({
    paneKey: `conversation-tab:${index}`,
    payload: { state, prompt: 'task', agentType: 'codex' },
    timing: { updatedAt: at, stateStartedAt: at, turnStartedAt: 1000 },
    routing: { worktreeId: 'wt-order' },
    metadata: { providerSession: { key: 'session_id', id: `session-${index}` } }
  })
  store
    .getState()
    .setAgentStatuses(Array.from({ length: size }, (_, index) => update(index, 'working', 1000)))
  expect(Object.keys(store.getState().agentConversationsByPaneKey)).toHaveLength(
    size === 100 ? 100 : 500
  )
  const target = size - 1
  const targetKey = `conversation-tab:${target}`
  let changes = 0
  const unsubscribe = store.subscribe((next, previous) => {
    if (next.agentConversationsByPaneKey !== previous.agentConversationsByPaneKey) {
      changes += 1
    }
  })
  const initial = store.getState().agentConversationsByPaneKey
  store.getState().setAgentStatuses([update(target, 'working', 2000)])
  const replay = update(target, 'working', 3000)
  replay.timing = { updatedAt: 3000, stateStartedAt: 1000, turnStartedAt: 1000, isReplay: true }
  store.getState().setAgentStatuses([replay])
  store
    .getState()
    .recordAgentProviderSession(targetKey, 'codex', { key: 'session_id', id: `session-${target}` })
  expect(store.getState().agentConversationsByPaneKey).toBe(initial)
  expect(changes).toBe(0)
  store.getState().setAgentStatuses([update(target, 'done', 4000)])
  const completed = store.getState().agentConversationsByPaneKey
  expect(changes).toBe(1)
  expect(Object.keys(completed)).toHaveLength(size === 100 ? 100 : 500)
  expect(completed[targetKey].continuity?.state).toBe('done')
  for (const key of Object.keys(initial)) {
    if (key !== targetKey) {
      expect(completed[key]).toBe(initial[key])
    }
  }
  store.getState().setAgentStatuses([update(target, 'working', 5000)])
  const beforeBatch = store.getState().agentConversationsByPaneKey
  changes = 0
  store
    .getState()
    .setAgentStatuses([target, target - 1, target - 2].map((index) => update(index, 'done', 6000)))
  const afterBatch = store.getState().agentConversationsByPaneKey
  expect(changes).toBe(1)
  for (const key of Object.keys(beforeBatch)) {
    if (![target, target - 1, target - 2].some((index) => key === `conversation-tab:${index}`)) {
      expect(afterBatch[key]).toBe(beforeBatch[key])
    }
  }
  expect(
    [target, target - 1, target - 2].map(
      (index) => afterBatch[`conversation-tab:${index}`].continuity?.state
    )
  ).toEqual(['done', 'done', 'done'])
  unsubscribe()
})
