import { resetAgentPaneAuthorityAliasesForTests } from '../../src/renderer/src/store/slices/agent-pane-authority'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../src/main/agent-hooks/server'
import { toAgentStatusIpcPayload } from '../../src/main/agent-hooks/server/server-status-identity'
import type { AgentStatusIpcPayload } from '../../src/shared/agent-status-types'
import { makePaneKey } from '../../src/shared/stable-pane-id'
import { isAgentStatusForRecentlyClosedTab } from '../../src/renderer/src/hooks/ipc-events/agent-status-routing'
import { createTestStore } from '../../src/renderer/src/store/slices/store-test-helpers'

vi.mock('../../src/main/telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../src/main/telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))
afterEach(() => {
  resetAgentPaneAuthorityAliasesForTests()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
const paneKey = makePaneKey('tab-omp', '11111111-1111-4111-8111-111111111111')

function fixture() {
  resetAgentPaneAuthorityAliasesForTests()
  vi.useFakeTimers()
  const server = new AgentHookServer()
  const store = createTestStore()
  const emitted: AgentStatusIpcPayload[] = []
  store.setState({
    tabsByWorktree: {
      'wt-1': [
        {
          id: 'tab-omp',
          ptyId: 'pty-1',
          worktreeId: 'wt-1',
          title: 'OMP',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        }
      ]
    }
  })
  vi.stubGlobal('window', {
    api: {
      agentStatus: {
        retirePaneAuthority: (key: string, id?: string) => server.retirePaneAuthority(key, id),
        dropByTabPrefix: (tabId: string) => server.dropStatusEntriesByTabPrefix(tabId)
      }
    }
  })
  server.setListener((event) =>
    emitted.push({
      ...toAgentStatusIpcPayload(event),
      ...(event.authorityRestartId ? { authorityRestartId: event.authorityRestartId } : {})
    })
  )
  const restart = () =>
    server.ingestRemote(
      {
        paneKey,
        source: 'omp',
        hookEventName: 'before_agent_start',
        payload: { agentType: 'omp', state: 'working', prompt: 'new turn' }
      },
      null
    )
  const apply = (data: AgentStatusIpcPayload, replay = false, batch = false) => {
    const id = replay ? undefined : data.authorityRestartId
    if (isAgentStatusForRecentlyClosedTab(store.getState(), data.paneKey, id)) {
      return
    }
    const update = {
      paneKey: data.paneKey,
      payload: data,
      timing: { updatedAt: data.receivedAt, stateStartedAt: data.stateStartedAt },
      metadata: id ? { authorityRestartId: id } : undefined
    }
    if (batch) {
      store.getState().setAgentStatuses([update])
    } else {
      store
        .getState()
        .setAgentStatus(
          update.paneKey,
          update.payload,
          undefined,
          update.timing,
          undefined,
          update.metadata
        )
    }
  }
  return { server, store, emitted, restart, apply }
}

describe('OMP host-authorized renderer retirement recovery', () => {
  it.each([false, true])(
    'recovers the matching retirement (batch=%s) without replayable authority',
    (batch) => {
      const f = fixture()
      f.store.getState().retireAgentPaneAuthority(paneKey)
      f.restart()
      expect(f.emitted).toHaveLength(1)
      expect(f.emitted[0].authorityRestartId).toBe(
        f.store.getState().recentlyRetiredAgentStatusPaneKeys[paneKey]
      )
      f.apply(f.emitted[0], false, batch)
      expect(f.store.getState().agentStatusByPaneKey[paneKey]?.state).toBe('working')
      expect(f.store.getState().recentlyRetiredAgentStatusPaneKeys[paneKey]).toBeUndefined()
      expect(f.server.getStatusSnapshot()[0]).not.toHaveProperty('authorityRestartId')
      const replay = vi.fn()
      f.server.setListener(replay)
      expect(replay.mock.calls[0][0]).not.toHaveProperty('authorityRestartId')
      f.server.stop()
    }
  )

  it('rejects an earlier restart after a second retirement, then accepts its own restart', () => {
    const f = fixture()
    f.store.getState().retireAgentPaneAuthority(paneKey)
    f.restart()
    const old = f.emitted[0]
    f.store.getState().retireAgentPaneAuthority(paneKey)
    expect(f.store.getState().recentlyRetiredAgentStatusPaneKeys[paneKey]).not.toBe(
      old.authorityRestartId
    )
    f.apply(old)
    expect(f.store.getState().agentStatusByPaneKey[paneKey]).toBeUndefined()
    f.restart()
    f.apply(f.emitted[1])
    expect(f.store.getState().agentStatusByPaneKey[paneKey]?.state).toBe('working')
    f.server.stop()
  })

  it.each(['replay', 'closed', 'missing-pane'])('does not restore on %s', (reason) => {
    const f = fixture()
    f.store.getState().retireAgentPaneAuthority(paneKey)
    f.restart()
    if (reason === 'closed') {
      f.store.getState().dropAgentStatusByTabPrefix('tab-omp')
    }
    if (reason === 'missing-pane') {
      f.store.setState({ tabsByWorktree: {} })
    }
    f.apply(f.emitted[0], reason === 'replay')
    expect(f.store.getState().agentStatusByPaneKey[paneKey]).toBeUndefined()
    expect(f.store.getState().recentlyRetiredAgentStatusPaneKeys[paneKey]).toBeDefined()
    f.server.stop()
  })
})

it.each([false, true])(
  'recovers a detached pane at its owner after repeat retirement=%s',
  (repeat) => {
    const f = fixture()
    const owner = makePaneKey('tab-owner', '22222222-2222-4222-8222-222222222222')
    f.server.transferPaneAuthority(paneKey, owner, 'pty-1')
    f.store
      .getState()
      .transferAgentPaneAuthority({ fromPaneKey: paneKey, toPaneKey: owner, ptyId: 'pty-1' })
    f.store.setState({
      tabsByWorktree: {
        'wt-1': [
          {
            id: 'tab-owner',
            ptyId: 'pty-1',
            worktreeId: 'wt-1',
            title: 'OMP',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      }
    })
    f.store.getState().retireAgentPaneAuthority(owner)
    if (repeat) {
      f.store.getState().retireAgentPaneAuthority(owner)
    }
    expect(f.store.getState().recentlyRetiredAgentStatusPaneKeys[paneKey]).toBe(
      f.store.getState().recentlyRetiredAgentStatusPaneKeys[owner]
    )
    f.restart()
    expect(f.emitted[0]).toMatchObject({ paneKey: owner, tabId: 'tab-owner' })
    f.apply(f.emitted[0])
    expect(f.store.getState().agentStatusByPaneKey[owner]?.state).toBe('working')
    expect(f.store.getState().agentStatusByPaneKey[paneKey]).toBeUndefined()
    f.server.stop()
  }
)

it('keeps explicit closure after tab-LRU eviction and repeated retirement', () => {
  const f = fixture()
  f.store.getState().retireAgentPaneAuthority(paneKey)
  f.restart()
  f.store.getState().dropAgentStatusByTabPrefix('tab-omp')
  for (let n = 0; n < 1025; n++) {
    f.store.getState().dropAgentStatusByTabPrefix(`other-${n}`)
  }
  expect(f.store.getState().recentlyClosedAgentStatusTabIds['tab-omp']).toBeUndefined()
  f.store.getState().retireAgentPaneAuthority(paneKey)
  expect(f.store.getState().recentlyRetiredAgentStatusPaneKeys[paneKey]).toBe(true)
  f.apply(f.emitted[0])
  f.restart()
  expect(f.emitted).toHaveLength(1)
  expect(f.store.getState().agentStatusByPaneKey[paneKey]).toBeUndefined()
  f.server.stop()
})

it.each([false, true])(
  'preserves detached-group closure across recovery cycles (batch=%s)',
  (batch) => {
    const f = fixture()
    const owner = makePaneKey('tab-owner', '22222222-2222-4222-8222-222222222222')
    f.server.transferPaneAuthority(paneKey, owner, 'pty-1')
    f.store
      .getState()
      .transferAgentPaneAuthority({ fromPaneKey: paneKey, toPaneKey: owner, ptyId: 'pty-1' })
    f.store.setState({
      tabsByWorktree: {
        'wt-1': [
          {
            id: 'tab-owner',
            ptyId: 'pty-1',
            worktreeId: 'wt-1',
            title: 'OMP',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      }
    })
    f.store.getState().retireAgentPaneAuthority(owner)
    f.restart()
    f.apply(f.emitted[0], false, batch)
    expect(f.store.getState().agentStatusByPaneKey[owner]?.state).toBe('working')
    f.store.getState().retireAgentPaneAuthority(owner)
    f.restart()
    f.store.getState().dropAgentStatusByTabPrefix('tab-omp')
    f.apply(f.emitted[1], false, batch)
    expect(f.store.getState().agentStatusByPaneKey[owner]).toBeUndefined()
    f.server.stop()
  }
)
