import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetAgentPaneAuthorityAliasesForTests } from '../agent-pane-authority'
import { wslHookRelayConnectionId } from '../../../../../shared/wsl-hook-relay-contract'
import { createTestStore } from '../store-test-helpers'
import { buildWorktreeAgentRows } from '@/components/sidebar/worktree-agent-rows'
import { AGENT_STATE_HISTORY_MAX } from '../../../../../shared/agent-status-types'
import { makePaneKey, parsePaneKey } from '../../../../../shared/stable-pane-id'
import type { AgentStatusTiming } from './agent-status-contract'
import { retainedAgentEntryFromLive } from './agent-status-pane-key-tab-binding'
import { applyWebSessionTabsSnapshot } from '@/runtime/web-session-tabs-sync/snapshot-api'
import { ENV, makeSnapshot, makeState } from '@/runtime/web-session-tabs-sync-test-harness'

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
      retained: [],
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
        retained: [],
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
      const entry = store.getState().agentStatusByPaneKey[pane]
      expect(retainedAgentEntryFromLive(store.getState(), 'wt-order', entry, agent).startedAt).toBe(
        1000
      )
    }
  )

  it('distinguishes known replacement from enrichment, omission and turn completion', () => {
    const { store, write, rows } = fixture('claude')
    write(1000, 'working')
    write(2000, 'working', 'A')
    write(3000, 'done', 'A')
    write(4000, 'working', 'A')
    expect(rows()[0].startedAt).toBe(1000)
    write(5000, 'done', 'A')
    write(6000, 'working', 'B')
    expect(rows()[0].startedAt).toBe(6000)
    const epoch = store.getState().agentStatusEpoch
    write(7000, 'working', 'C')
    expect(rows()[0].startedAt).toBe(7000)
    expect(store.getState().agentStatusEpoch).toBeGreaterThan(epoch)
    write(8000, 'working')
    write(7500, 'done', 'D')
    expect(rows()[0].startedAt).toBe(7000)
    store.getState().dropAgentStatus(pane)
    write(9000, 'working', 'E')
    expect(rows()[0].startedAt).toBe(9000)
  })

  it('reuses a retained displayed origin only for an uncontradicted session', () => {
    const { store, write, rows } = fixture('claude')
    write(1000, 'done', 'A')
    const retained = retainedAgentEntryFromLive(
      store.getState(),
      'wt-order',
      store.getState().agentStatusByPaneKey[pane],
      'claude'
    )
    store.setState({ agentStatusByPaneKey: {}, retainedAgentsByPaneKey: { [pane]: retained } })
    write(3000, 'working', 'A')
    expect(rows()[0].startedAt).toBe(1000)
    store.setState({ agentStatusByPaneKey: {}, retainedAgentsByPaneKey: { [pane]: retained } })
    write(5000, 'working', 'B')
    expect(rows()[0].startedAt).toBe(5000)
  })
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

it('does not treat a newly available Pi transcript path as a new session', () => {
  const { store, write, rows } = fixture('pi')
  write(1000, 'working', 'A')
  store
    .getState()
    .setAgentStatus(
      pane,
      { state: 'working', prompt: 'task', agentType: 'pi' },
      undefined,
      { updatedAt: 2000 },
      undefined,
      { providerSession: { key: 'session_id', id: 'A', transcriptPath: '/qa/pi/session.jsonl' } }
    )
  expect(rows()[0].startedAt).toBe(1000)
})
