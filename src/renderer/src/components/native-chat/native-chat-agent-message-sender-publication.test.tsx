// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeTab } from '@/store/slices/store-test-helpers'
import { useAgentMessageSenderView } from './native-chat-agent-message-sender-view'
import {
  initialStore,
  resetSenderStore,
  LEAF,
  status,
  from
} from './native-chat-agent-sender.test-fixture'
import {
  agentSenderIndexWorkForTest,
  agentSenderPublicationPatch,
  selectAgentSenderAssociation
} from '@/runtime/agent-sender-associations'
import type { AgentSenderPublication } from '../../../../shared/agent-sender-associations'
import type { AgentMessageSender } from '../../../../shared/agent-session/agent-session-message-source'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../shared/structured-agent-session-projection'
import { testOrcaSessionId } from '../../../../shared/orca-session-address-test-fixture'
import { applyWebSessionTabsSnapshot } from '@/runtime/web-session-tabs-sync/snapshot-api'

const publication = (
  associations: AgentSenderPublication['associations'] = []
): AgentSenderPublication => ({ associations, federation: [], attachments: [] })
const association = (i: number) => ({
  address: `term_${i}`,
  paneKey: status(i).paneKey,
  worktreeId: 'workspace'
})
const sender = (address: string): AgentMessageSender => ({
  party: { address, terminalHandle: address, orcaSessionId: null },
  name: 'Sender',
  agent: 'codex'
})
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(2_000_000)
  resetSenderStore()
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initialStore, true)
  vi.useRealTimers()
})
it('finds title/process-only terminal rows and uses their sidebar dot before a hook arrives', () => {
  useAppStore.setState({
    agentStatusByPaneKey: {},
    ptyIdsByTabId: { 'tab-0': ['pty'] },
    terminalLayoutsByTabId: {
      'tab-0': { root: { type: 'leaf', leafId: LEAF }, activeLeafId: LEAF, expandedLeafId: null }
    },
    runtimePaneTitlesByTabId: { 'tab-0': { 1: '✳ Claude Code' } }
  })
  useAppStore.getState().setAgentSenderPublication('local', publication([association(0)]))
  const hook = renderHook(() =>
    useAgentMessageSenderView(from.senders[0], 'workspace', { kind: 'local' })
  )
  expect(hook.result.current).toMatchObject({ agentType: 'claude', dot: 'idle' })
})
it('finds a chat before tab hydration and follows its canonical /clear successor', () => {
  const root = testOrcaSessionId('11111111-1111-4111-8111-111111111111')
  const live = testOrcaSessionId('22222222-2222-4222-8222-222222222222')
  const paneKey = structuredAgentSessionPaneKey(structuredAgentSessionTabId(live), live)
  useAppStore.setState({
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    agentStatusByPaneKey: { [paneKey]: { ...status(0), paneKey, terminalHandle: undefined } }
  })
  useAppStore
    .getState()
    .setAgentSenderPublication(
      'local',
      publication([
        { address: `orca_session_id:${root}`, paneKey, worktreeId: 'workspace', sessionId: live }
      ])
    )
  const hook = renderHook(() =>
    useAgentMessageSenderView(
      {
        ...sender(`orca_session_id:${root}`),
        party: { address: `orca_session_id:${root}`, orcaSessionId: root, terminalHandle: null }
      },
      'workspace',
      { kind: 'local' }
    )
  )
  expect(hook.result.current).toMatchObject({ agentType: 'claude', dot: 'working' })
})
it('resolves Started-worker dispatches after restart; old-host absence and authoritative empty differ', () => {
  const saved = sender('term_before_restart')
  useAppStore
    .getState()
    .setAgentSenderPublication(
      'local',
      publication([{ ...association(0), address: 'dispatch:worker' }])
    )
  const hook = renderHook(() =>
    useAgentMessageSenderView(saved, 'workspace', { kind: 'local' }, 'worker')
  )
  expect(hook.result.current.dot).toBe('working')
  act(() => useAppStore.getState().setAgentSenderPublication('local', publication()))
  expect(hook.result.current).toEqual({ agentType: 'codex' })
  const legacy = renderHook(() =>
    useAgentMessageSenderView(from.senders[0], 'workspace', { kind: 'local' })
  )
  expect(legacy.result.current.dot).toBeUndefined()
  act(() => useAppStore.getState().setAgentSenderPublication('local', undefined))
  expect(legacy.result.current.dot).toBe('working')
})
it('qualifies federation by both execution peer and the attachment home principal', () => {
  const home = {
    ...publication(),
    federation: [
      { dispatchId: 'same', peerFingerprint: 'execution', homePeerFingerprint: 'home-a' }
    ]
  }
  useAppStore.setState({
    agentSenderPublicationsByHost: {
      local: { '*': home },
      'runtime:remote': {
        workspace: {
          ...publication(),
          peerFingerprint: 'execution',
          attachments: [
            { ...association(0), address: 'dispatch:same', homePeerFingerprint: 'home-b' }
          ]
        }
      }
    }
  })
  const read = () =>
    selectAgentSenderAssociation(useAppStore.getState(), 'local', sender('dispatch:same'))
  expect(read()).toBeUndefined()
  useAppStore.setState(
    agentSenderPublicationPatch(useAppStore.getState(), 'runtime:remote', 'workspace', {
      ...publication(),
      peerFingerprint: 'execution',
      attachments: [{ ...association(0), address: 'dispatch:same', homePeerFingerprint: 'home-a' }]
    })
  )
  expect(read()?.host).toBe('runtime:remote')
  useAppStore.setState(
    agentSenderPublicationPatch(useAppStore.getState(), 'runtime:other', 'workspace', {
      ...publication(),
      peerFingerprint: 'execution',
      attachments: [{ ...association(1), address: 'dispatch:same', homePeerFingerprint: 'home-a' }]
    })
  )
  expect(read()).toBeUndefined()
})
it('receives an authoritative remote publication on the same snapshot path as remote rows', () => {
  const snapshot = {
    worktree: 'workspace',
    publicationEpoch: 'host',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: [],
    agentSenderAssociations: publication([{ ...association(0), address: 'same-session' }])
  } as const
  useAppStore.setState(applyWebSessionTabsSnapshot(useAppStore.getState(), snapshot, 'remote'))
  expect(
    selectAgentSenderAssociation(useAppStore.getState(), 'runtime:remote', sender('same-session'))
      ?.host
  ).toBe('runtime:remote')
  expect(
    selectAgentSenderAssociation(useAppStore.getState(), 'local', sender('same-session'))
  ).toBeUndefined()
})
it.each([100, 1000])(
  'shares one identity index across %i cards and does not rebuild it for status writes',
  (n) => {
    useAppStore.setState({
      agentStatusByPaneKey: Object.fromEntries(
        Array.from({ length: n }, (_, i) => [status(i).paneKey, status(i)])
      ),
      tabsByWorktree: {
        workspace: Array.from({ length: n }, (_, i) =>
          makeTab({ id: `tab-${i}`, worktreeId: 'workspace' })
        )
      }
    })
    useAppStore
      .getState()
      .setAgentSenderPublication(
        'local',
        publication(Array.from({ length: n }, (_, i) => association(i)))
      )
    const before = agentSenderIndexWorkForTest()
    let renders = 0
    const hook = renderHook(() => {
      renders++
      return useAgentMessageSenderView(from.senders[0], 'workspace', { kind: 'local' })
    })
    for (let i = 0; i < n; i++) {
      expect(
        selectAgentSenderAssociation(useAppStore.getState(), 'local', sender(`term_${i}`))?.paneKey
      ).toBe(status(i).paneKey)
    }
    expect(agentSenderIndexWorkForTest()).toEqual({
      builds: before.builds + 1,
      visits: before.visits + n
    })
    let unaffectedRenders = 0
    const unaffected = renderHook(() => {
      unaffectedRenders++
      return useAgentMessageSenderView(sender('other-sender'), 'other', {
        kind: 'environment',
        environmentId: 'other'
      })
    })
    const otherMounted = unaffectedRenders
    const mounted = renders
    const published = useAppStore.getState().agentSenderPublicationsByHost
    act(() =>
      useAppStore.setState(
        agentSenderPublicationPatch(
          useAppStore.getState(),
          'local',
          'workspace',
          publication(Array.from({ length: n }, (_, i) => association(i)))
        )
      )
    )
    expect(useAppStore.getState().agentSenderPublicationsByHost).toBe(published)
    act(() => useAppStore.setState({ sidebarBody: 'agents' }))
    expect(renders).toBe(mounted)
    act(() =>
      useAppStore.setState(
        agentSenderPublicationPatch(
          useAppStore.getState(),
          'runtime:other',
          'other',
          publication([{ address: 'unrelated', paneKey: 'other', worktreeId: 'other' }])
        )
      )
    )
    expect(renders).toBe(mounted)
    expect(unaffectedRenders).toBe(otherMounted)
    const indexed = agentSenderIndexWorkForTest()
    act(() =>
      useAppStore.setState({
        tabsByWorktree: {
          workspace: useAppStore
            .getState()
            .tabsByWorktree.workspace.map((tab) => ({ ...tab, title: 'Changed status title' }))
        }
      })
    )
    expect(agentSenderIndexWorkForTest()).toEqual(indexed)
    act(() =>
      useAppStore.getState().setAgentProgramStatus(status(0).paneKey, {
        state: 'working',
        progress: 42,
        observedAt: 2_000_000
      })
    )
    expect(hook.result.current.progress).toBe(42)
    expect(renders).toBe(mounted + 1)
    expect(unaffectedRenders).toBe(otherMounted)
    expect(unaffected.result.current.dot).toBeUndefined()
    expect(agentSenderIndexWorkForTest()).toEqual(indexed)
  }
)

it('keeps equal session ids on two hosts separate and rejects an unqualified pane collision', () => {
  const sessionId = testOrcaSessionId('11111111-1111-4111-8111-111111111111')
  const identity = {
    ...sender(`orca_session_id:${sessionId}`),
    party: {
      address: `orca_session_id:${sessionId}`,
      terminalHandle: null,
      orcaSessionId: sessionId
    }
  }
  const row = {
    address: identity.party.address,
    paneKey: 'canonical',
    sessionId,
    worktreeId: 'workspace'
  }
  useAppStore.setState({
    agentSenderPublicationsByHost: {
      local: { '*': publication([row]) },
      'runtime:remote': { workspace: publication([row]) }
    }
  })
  expect(selectAgentSenderAssociation(useAppStore.getState(), 'local', identity)).toBeUndefined()
  expect(
    selectAgentSenderAssociation(useAppStore.getState(), 'runtime:remote', identity)
  ).toBeUndefined()
  useAppStore.setState(
    agentSenderPublicationPatch(
      useAppStore.getState(),
      'runtime:remote',
      'workspace',
      publication([{ ...row, paneKey: 'remote-pane' }])
    )
  )
  expect(selectAgentSenderAssociation(useAppStore.getState(), 'local', identity)?.paneKey).toBe(
    'canonical'
  )
  expect(
    selectAgentSenderAssociation(useAppStore.getState(), 'runtime:remote', identity)?.paneKey
  ).toBe('remote-pane')
})
