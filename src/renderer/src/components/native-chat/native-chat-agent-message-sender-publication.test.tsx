// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeTab } from '@/store/slices/store-test-helpers'
import {
  useAgentMessageSenderOpens,
  useAgentMessageSenderView
} from './native-chat-agent-message-sender-view'
import { agentMessageSenderRowBuildsForTest } from './native-chat-agent-message-sender-source'
import { useAgentMessageSenderLabel } from './native-chat-agent-message-sender-label'
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
import type { Tab } from '../../../../shared/tab-types'
import type {
  RuntimeMobileSessionTabsRemovedResult,
  RuntimeMobileSessionTabsResult
} from '../../../../shared/runtime-types'
import { applyWebSessionTabsSnapshot } from '@/runtime/web-session-tabs-sync/snapshot-api'
import { applyReceivedAgentSenderPublications } from '@/runtime/web-session-tabs-sync/received-agent-sender-publications'

let revision = 0
/** Each delivery is the host's next revision, as a publishing host stamps it. */
const publication = (
  associations: AgentSenderPublication['associations'] = []
): AgentSenderPublication => ({
  associations,
  principals: [],
  attachments: [],
  revision: { epoch: 'host', revision: ++revision }
})
const association = (i: number) => ({
  identity: `term_${i}`,
  paneKey: status(i).paneKey,
  worktreeId: 'workspace'
})
// A federated sender is named by its Dispatch address; any other by the handle it sent from.
const sender = (identity: string): AgentMessageSender =>
  identity.startsWith('dispatch:')
    ? { party: { address: identity, terminalHandle: null, orcaSessionId: null }, name: 'Sender' }
    : {
        party: { address: identity, terminalHandle: identity, orcaSessionId: null },
        name: 'Sender',
        agent: 'claude'
      }
const proved = from.senders[0]
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
  const hook = renderHook(() => useAgentMessageSenderView(proved, 'workspace', { kind: 'local' }))
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
        { identity: `orca_session_id:${root}`, paneKey, worktreeId: 'workspace', sessionId: live }
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
      publication([{ ...association(0), identity: 'dispatch:worker' }])
    )
  const hook = renderHook(() =>
    useAgentMessageSenderView(saved, 'workspace', { kind: 'local' }, 'worker')
  )
  expect(hook.result.current.dot).toBe('working')
  act(() => useAppStore.getState().setAgentSenderPublication('local', publication()))
  expect(hook.result.current).toEqual({ agentType: 'claude' })
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
    principals: [{ peerFingerprint: 'execution', homePeerFingerprint: 'home-a' }]
  }
  useAppStore.setState({
    agentSenderPublicationsByHost: {
      local: { '*': home },
      'runtime:remote': {
        workspace: {
          ...publication(),
          peerFingerprint: 'execution',
          attachments: [
            { ...association(0), identity: 'dispatch:same', homePeerFingerprint: 'home-b' }
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
      attachments: [{ ...association(0), identity: 'dispatch:same', homePeerFingerprint: 'home-a' }]
    })
  )
  expect(read()?.host).toBe('runtime:remote')
  // The home's card draws the dot of the worker running on its paired host.
  expect(
    renderHook(() =>
      useAgentMessageSenderView(sender('dispatch:same'), 'workspace', { kind: 'local' })
    ).result.current.dot
  ).toBe('working')
  // The same execution peer reached as a second host makes the match ambiguous, not a pick.
  useAppStore.setState(
    agentSenderPublicationPatch(useAppStore.getState(), 'runtime:other', 'workspace', {
      ...publication(),
      peerFingerprint: 'execution',
      attachments: [{ ...association(1), identity: 'dispatch:same', homePeerFingerprint: 'home-a' }]
    })
  )
  expect(read()).toBeUndefined()
})
it('a worktree removal frame drops only its own scope and keeps the host authoritative', () => {
  const frame = (worktree: string, agentSenderAssociations?: AgentSenderPublication) => ({
    worktree,
    publicationEpoch: 'host',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: [],
    ...(agentSenderAssociations ? { agentSenderAssociations } : {})
  })
  const removal = (worktree: string): RuntimeMobileSessionTabsRemovedResult => ({
    ...frame(worktree),
    removed: true,
    tabs: []
  })
  // The receipt applies sender scopes; the accepted tab frame applies a worktree's removal.
  const apply = (snapshot: Parameters<typeof applyWebSessionTabsSnapshot>[1]) => {
    applyReceivedAgentSenderPublications('remote', [snapshot], undefined)
    useAppStore.setState(applyWebSessionTabsSnapshot(useAppStore.getState(), snapshot, 'remote'))
  }
  const worker = { ...association(0), identity: 'term_worker', worktreeId: 'w3' }
  apply(frame('w2', publication()))
  apply(frame('w3', publication([worker])))
  apply({ ...frame('w1', publication([{ ...association(1), worktreeId: 'w1' }])) })
  const located = () =>
    selectAgentSenderAssociation(useAppStore.getState(), 'runtime:remote', sender('term_worker'))
  expect(located()?.worktreeId).toBe('w3')
  apply(removal('w1'))
  apply(frame('w2', publication()))
  expect(located()?.worktreeId).toBe('w3')
  expect(
    Object.keys(useAppStore.getState().agentSenderPublicationsByHost['runtime:remote'])
  ).toEqual(['w2', 'w3'])
  // A frame that doesn't carry the field never makes a publishing host look old.
  apply(frame('w2'))
  apply(removal('w3'))
  const view = renderHook(() =>
    useAgentMessageSenderView(sender('term_worker'), 'w2', {
      kind: 'environment',
      environmentId: 'remote'
    })
  )
  expect(view.result.current).toEqual({ agentType: 'claude' })
})
it('a located chat keeps its tab agent icon for a card saved without one', () => {
  const sessionId = testOrcaSessionId('33333333-3333-4333-8333-333333333333')
  const tab = makeTab({ id: 'chat-tab', worktreeId: 'workspace' })
  const chat: Tab = {
    ...tab,
    groupId: 'group',
    label: 'Chat',
    customLabel: null,
    contentType: 'agent-session',
    entityId: sessionId,
    agentSessionAgent: 'gemini'
  }
  useAppStore.setState({
    unifiedTabsByWorktree: { workspace: [chat] },
    agentStatusByPaneKey: {}
  })
  const paneKey = structuredAgentSessionPaneKey(structuredAgentSessionTabId(sessionId), sessionId)
  useAppStore
    .getState()
    .setAgentSenderPublication(
      'local',
      publication([
        { identity: `orca_session_id:${sessionId}`, paneKey, worktreeId: 'workspace', sessionId }
      ])
    )
  const { agent: _saved, ...unsaved } = sender(`orca_session_id:${sessionId}`)
  const hook = renderHook(() =>
    useAgentMessageSenderView(
      {
        ...unsaved,
        party: {
          address: `orca_session_id:${sessionId}`,
          orcaSessionId: sessionId,
          terminalHandle: null
        }
      },
      'workspace',
      { kind: 'local' }
    )
  )
  expect(hook.result.current).toEqual({ agentType: 'gemini' })
})
it('receives an authoritative remote publication on the same snapshot path as remote rows', () => {
  const snapshot: RuntimeMobileSessionTabsResult = {
    worktree: 'workspace',
    publicationEpoch: 'host',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: [],
    agentSenderAssociations: publication([{ ...association(0), identity: 'term_same' }])
  }
  applyReceivedAgentSenderPublications('remote', [snapshot], undefined)
  expect(
    selectAgentSenderAssociation(useAppStore.getState(), 'runtime:remote', sender('term_same'))
      ?.host
  ).toBe('runtime:remote')
  expect(
    selectAgentSenderAssociation(useAppStore.getState(), 'local', sender('term_same'))
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
    const whole = publication(Array.from({ length: n }, (_, i) => association(i)))
    useAppStore.getState().setAgentSenderPublication('local', whole)
    const before = agentSenderIndexWorkForTest()
    let renders = 0
    const hook = renderHook(() => {
      renders++
      return useAgentMessageSenderView(proved, 'workspace', { kind: 'local' })
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
        // The same revision again, as that worktree's scope from a frame.
        agentSenderPublicationPatch(useAppStore.getState(), 'local', 'workspace', whole)
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
          publication([{ identity: 'unrelated', paneKey: 'other', worktreeId: 'other' }])
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
    identity: identity.party.address,
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

it.each([100, 1000])(
  'renders no card name and rebuilds no rows for an update that changes nothing it shows, at %i senders',
  (n) => {
    const LOCAL = { kind: 'local' } as const
    const rows = Array.from({ length: n }, (_, i) => association(i))
    useAppStore.setState({
      agentStatusByPaneKey: Object.fromEntries(rows.map((_, i) => [status(i).paneKey, status(i)])),
      tabsByWorktree: {
        workspace: rows.map((_, i) => makeTab({ id: `tab-${i}`, worktreeId: 'workspace' }))
      }
    })
    useAppStore.getState().setAgentSenderPublication('local', publication(rows))
    let renders = 0
    // Each card's name with no avatar beside it (queued mail, a card's later senders): the label
    // and link hooks NativeChatAgentMessageSenders draws.
    const cards = Array.from({ length: 50 }, (_, i) => {
      const named = { ...sender(`term_${i}`), name: `Sender ${i}` }
      return renderHook(() => {
        renders++
        const label = useAgentMessageSenderLabel(named, 'workspace', LOCAL)
        const opens = useAgentMessageSenderOpens(named, 'workspace', LOCAL)
        return { label, opens }
      })
    })
    expect(cards[0].result.current.opens).toBe(true)
    const rendersFor = (update: () => void) => {
      const before = renders
      act(update)
      return renders - before
    }
    // The link's kind check reads the senders' sidebar rows; a write they don't read rebuilds none.
    const builds = agentMessageSenderRowBuildsForTest()
    expect(rendersFor(() => useAppStore.setState({ sidebarBody: 'agents' }))).toBe(0)
    expect(agentMessageSenderRowBuildsForTest()).toBe(builds)
    expect(
      rendersFor(() =>
        useAppStore.setState(
          agentSenderPublicationPatch(
            useAppStore.getState(),
            'runtime:other',
            'other',
            publication([{ identity: 'unrelated', paneKey: 'other', worktreeId: 'other' }])
          )
        )
      )
    ).toBe(0)
    expect(agentMessageSenderRowBuildsForTest()).toBe(builds)
    expect(
      rendersFor(() =>
        useAppStore.getState().setAgentProgramStatus(status(0).paneKey, {
          state: 'working',
          progress: 42,
          observedAt: 2_000_000
        })
      )
    ).toBe(0)
    // The same host moves a row no mounted card names.
    const moved = rows.map((row, i) =>
      i === n - 1 ? { ...row, paneKey: status(0).paneKey.replace('tab-0', 'tab-x') } : row
    )
    expect(
      rendersFor(() =>
        useAppStore.getState().setAgentSenderPublication('local', publication(moved))
      )
    ).toBe(0)
    // Card 0's sender is gone: only that card renders.
    expect(
      rendersFor(() =>
        useAppStore.getState().setAgentSenderPublication('local', publication(rows.slice(1)))
      )
    ).toBe(1)
    expect(cards[0].result.current.label).toBe('Sender 0')
  }
)

it.each([100, 1000])(
  'holds a replaced card’s rows as a located card’s: a write it doesn’t read renders and rebuilds nothing, at %i senders',
  (n) => {
    const LOCAL = { kind: 'local' } as const
    const rows = Array.from({ length: n }, (_, i) => association(i))
    useAppStore.setState({
      agentStatusByPaneKey: Object.fromEntries(rows.map((_, i) => [status(i).paneKey, status(i)])),
      tabsByWorktree: {
        workspace: rows.map((_, i) => makeTab({ id: `tab-${i}`, worktreeId: 'workspace' }))
      }
    })
    useAppStore.getState().setAgentSenderPublication('local', publication(rows))
    let renders = 0
    // Cards saved by Codex senders whose terminals now run Claude: half draw only the name, half
    // the avatar beside it.
    const useNameOnly = (replaced: AgentMessageSender) => ({
      opens: useAgentMessageSenderOpens(replaced, 'workspace', LOCAL),
      dot: undefined
    })
    const useNameAndAvatar = (replaced: AgentMessageSender) => ({
      opens: useAgentMessageSenderOpens(replaced, 'workspace', LOCAL),
      dot: useAgentMessageSenderView(replaced, 'workspace', LOCAL).dot
    })
    const cards = Array.from({ length: 50 }, (_, i) => {
      const replaced: AgentMessageSender = { ...sender(`term_${i}`), agent: 'codex' }
      const useCard = i % 2 === 0 ? useNameAndAvatar : useNameOnly
      return renderHook(() => {
        renders++
        return useCard(replaced)
      })
    })
    expect(cards.map((card) => card.result.current)).toEqual(
      cards.map(() => ({ opens: false, dot: undefined }))
    )
    const rendersFor = (update: () => void) => {
      const before = renders
      act(update)
      return renders - before
    }
    const builds = agentMessageSenderRowBuildsForTest()
    expect(rendersFor(() => useAppStore.setState({ sidebarBody: 'agents' }))).toBe(0)
    expect(
      rendersFor(() =>
        useAppStore.setState(
          agentSenderPublicationPatch(
            useAppStore.getState(),
            'runtime:other',
            'other',
            publication([{ identity: 'unrelated', paneKey: 'other', worktreeId: 'other' }])
          )
        )
      )
    ).toBe(0)
    expect(agentMessageSenderRowBuildsForTest()).toBe(builds)
    // Codex runs in card 0's terminal again: that card alone draws its link.
    expect(
      rendersFor(() =>
        useAppStore.setState({
          agentStatusByPaneKey: {
            ...useAppStore.getState().agentStatusByPaneKey,
            [status(0).paneKey]: { ...status(0), agentType: 'codex' }
          }
        })
      )
    ).toBe(1)
    expect(cards[0].result.current).toEqual({ opens: true, dot: 'working' })
  }
)
