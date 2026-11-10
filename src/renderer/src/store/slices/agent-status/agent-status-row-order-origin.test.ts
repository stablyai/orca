import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetAgentPaneAuthorityAliasesForTests } from './agent-pane-authority'
import { wslHookRelayConnectionId } from '../../../../../shared/wsl-hook-relay-contract'
import { createTestStore } from '../../testing/app-store-test-fixture'
import { buildWorktreeAgentRows } from '@/components/sidebar/workspace-card/activity/worktree-agent-rows'
import { AGENT_STATE_HISTORY_MAX } from '../../../../../shared/agent-status/lifecycle/agent-state-history'
import { makePaneKey, parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import type { AgentStatusTiming } from './agent-status-contract'
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
      entries: Object.values(store.getState().agentStatusByPaneKey),
      now: 1_000_000
    })
  return { store, write, rows }
}

describe('observed agent session row origin', () => {
  it('carries a source-dated replacement from local status through paired row projection', () => {
    const { store, write, rows } = fixture('claude')
    let client = makeState()
    const publish = (version: number) => {
      const tabs = Object.values(store.getState().agentStatusByPaneKey).map((entry) => {
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
        entries: Object.values(client.agentStatusByPaneKey),
        now: 1_000_000 + version
      })
    }
    write(1000, 'working', 'A')
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
    write(7000, 'working', 'B', { stateStartedAt: 1000, evidenceObservedAt: 6000 })
    expect(store.getState().agentStatusByPaneKey[pane]).toMatchObject({
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
      write(1000, 'working')
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
        write(3000 + i * 1000, i % 2 ? 'working' : 'done')
      }
      expect(store.getState().agentStatusByPaneKey[pane].stateHistory[0].startedAt).toBeGreaterThan(
        2000
      )
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
  expect(store.getState().agentStatusByPaneKey[pane].firstStateStartedAt).toBe(1000)
  expect(store.getState().agentConversationsByPaneKey[pane].providerSession?.id).toBe('A')
  const conversations = store.getState().agentConversationsByPaneKey
  publish(7000, 'done', 'A')
  expect(store.getState().agentStatusByPaneKey[pane].firstStateStartedAt).toBe(1000)
  expect(store.getState().agentConversationsByPaneKey).toBe(conversations)
  store.getState().removeAgentStatus(pane)
  publish(8000, 'working', 'B')
  expect(store.getState().agentStatusByPaneKey[pane].firstStateStartedAt).toBe(8000)
})

it('keeps an old paired host session clock across omission and provider-less replay', () => {
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
                stateStartedAt: at,
                stateHistory: [],
                ...(session ? { providerSession: { key: 'session_id' as const, id: session } } : {})
              }
            }
          ],
          { worktree: 'wt-order', snapshotVersion: version }
        ),
        ENV,
        1_000_000 + version
      )
    }
    return Object.values(client.agentStatusByPaneKey)[0]
  }
  const initial = publish(1, 1000, 'working', 'A')
  expect(initial.firstStateStartedAt).toBe(1000)
  expect(publish(2, 5000, 'done', 'A').firstStateStartedAt).toBe(1000)
  client = { ...client, agentStatusByPaneKey: {} }
  expect(publish(3, 6000, 'done').firstStateStartedAt).toBe(1000)
  expect(client.agentConversationsByPaneKey?.[initial.paneKey].providerSession?.id).toBe('A')
  const conversations = client.agentConversationsByPaneKey
  publish(4, 7000, 'done', 'A')
  expect(client.agentConversationsByPaneKey).toBe(conversations)
  client = { ...client, agentStatusByPaneKey: {} }
  expect(publish(5, 8000, 'working', 'B').firstStateStartedAt).toBe(8000)
})
