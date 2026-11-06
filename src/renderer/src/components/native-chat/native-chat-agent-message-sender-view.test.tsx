// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { render } from './native-chat-tooltip-test-harness'
import { useAppStore } from '@/store'
import { makeTab, makeWorktree, TEST_REPO } from '@/store/slices/store-test-helpers'
import type { TerminalLayoutSnapshot } from '../../../../shared/workspace-layout/terminal-tab-types'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { AgentMessageSenderView } from '../../../../shared/agent-session/agent-message-presentation'
import { parseOrcaSessionAddress } from '../../../../shared/orca-session-address'
import * as presentation from '@/lib/program-status/agent-row-presentation'
import * as senderTargets from './native-chat-agent-message-sender-target'
import '@/components/sidebar/workspace-card/activity/worktree-agent-row-selectors'
import { useAgentMessageSenderView } from './native-chat-agent-message-sender-view'
import {
  initialStore,
  LEAF,
  status,
  resetSenderStore
} from './native-chat-agent-sender.test-fixture'

const renders = new Map<number, number>()
const views = new Map<number, AgentMessageSenderView>()
function Probe({
  id,
  workspace = 'workspace',
  remote = false,
  sourceId = id,
  proof = 'live'
}: {
  id: number
  workspace?: string
  remote?: boolean
  sourceId?: number
  proof?: 'live' | 'gone' | 'terminal'
}) {
  const value = useAgentMessageSenderView(
    {
      party: {
        address: `term_${sourceId}`,
        terminalHandle: `term_${sourceId}`,
        orcaSessionId: null
      },
      name: 'Sender',
      ...(proof === 'gone' ? { agent: 'claude' } : {})
    },
    workspace,
    remote ? { kind: 'environment', environmentId: 'remote' } : { kind: 'local' },
    proof === 'terminal' ? undefined : `${proof === 'gone' ? 'closed' : 'source'}-${sourceId}`
  )
  views.set(id, value)
  renders.set(id, (renders.get(id) ?? 0) + 1)
  return null
}
let publicationRevision = 0
function publishSources(n: number, host = 'local', worktreeId = 'workspace', handles = false) {
  useAppStore.getState().setAgentSenderPublication(host, {
    associations: Array.from({ length: n }, (_, i) =>
      [`dispatch:source-${i}`, ...(handles ? [`term_${i}`] : [])].map((identity) => ({
        identity,
        paneKey: status(i).paneKey,
        worktreeId,
        dispatchActor: true as const
      }))
    ).flat(),
    principals: [],
    attachments: [],
    revision: { epoch: 'activity', revision: ++publicationRevision }
  })
}
function write(i: number, update: Partial<AgentStatusEntry>) {
  const state = useAppStore.getState()
  const key = status(i).paneKey
  act(() =>
    useAppStore.setState({
      agentStatusByPaneKey: {
        ...state.agentStatusByPaneKey,
        [key]: { ...state.agentStatusByPaneKey[key], ...update }
      },
      agentStatusEpoch: state.agentStatusEpoch + 1
    })
  )
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(2_000_000)
  renders.clear()
  views.clear()
  resetSenderStore()
  publishSources(1)
  publishSources(10, 'runtime:remote', 'remote')
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initialStore, true)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it.each([100, 1000])(
  'bounds proved, gone-proof and plain-terminal cards across %i status rows',
  (n) => {
    let visits = 0
    const track = (entries: Record<string, AgentStatusEntry>) =>
      new Proxy(entries, {
        ownKeys(target) {
          const keys = Object.getOwnPropertyNames(target)
          visits += keys.length
          return keys
        }
      })
    const live = track(
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => {
          const entry = status(i)
          return [entry.paneKey, entry]
        })
      )
    )
    useAppStore.setState({
      agentStatusByPaneKey: live,
      tabsByWorktree: {
        workspace: Array.from({ length: n }, (_, i) =>
          makeTab({ id: `tab-${i}`, worktreeId: 'workspace' })
        )
      },
      terminalLayoutsByTabId: Object.fromEntries(
        Array.from({ length: n }, (_, i): [string, TerminalLayoutSnapshot] => [
          `tab-${i}`,
          { root: { type: 'leaf', leafId: LEAF }, activeLeafId: LEAF, expandedLeafId: null }
        ])
      )
    })
    publishSources(n, 'local', 'workspace', true)
    const normalize = vi.spyOn(presentation, 'resolveRowProgramStatus')
    const resolve = vi.spyOn(senderTargets, 'resolveAgentMessageSenderTarget')
    const mounted = render(
      <>
        {Array.from({ length: n }, (_, id) => (
          <span key={id}>
            <Probe id={id} />
            <Probe id={n + id} sourceId={id} proof="gone" />
            <Probe id={2 * n + id} sourceId={id} proof="terminal" />
          </span>
        ))}
      </>
    )
    // Both fallback cohorts share the existing sender index and row source.
    expect(visits).toBeLessThanOrEqual(n * 3)
    expect(normalize).toHaveBeenCalledTimes(n)
    for (let i = 0; i < n; i++) {
      expect(views.get(i)?.dot).toBe('working')
      expect(views.get(n + i)).toEqual({ agentType: 'claude' })
      expect(views.get(2 * n + i)).toEqual({ agentType: 'claude' })
    }
    const before = new Map(renders)
    visits = 0
    normalize.mockClear()
    resolve.mockClear()
    act(() => useAppStore.setState({ sidebarBody: 'agents' }))
    expect(visits).toBe(0)
    expect(normalize).not.toHaveBeenCalled()
    expect(resolve.mock.calls.length).toBeLessThanOrEqual(n * 4)
    expect(renders).toEqual(before)
    for (const progress of [40, 60]) {
      const state = useAppStore.getState()
      const entries = { ...state.agentStatusByPaneKey }
      const key = status(0).paneKey
      entries[key] = {
        ...entries[key],
        programStatus: { state: 'working', progress, observedAt: 2_000_000 }
      }
      visits = 0
      normalize.mockClear()
      resolve.mockClear()
      const epoch = state.agentStatusEpoch
      act(() => useAppStore.setState({ agentStatusByPaneKey: track(entries) }))
      expect(visits).toBeLessThanOrEqual(n * 3)
      expect(resolve.mock.calls.length).toBeGreaterThanOrEqual(n * 4)
      expect(resolve.mock.calls.length).toBeLessThanOrEqual(n * 8)
      expect(useAppStore.getState().agentStatusEpoch).toBe(epoch)
      expect(normalize).toHaveBeenCalledTimes(n)
      expect(views.get(0)?.progress).toBe(progress)
      expect(renders.get(0)).toBe(before.get(0)! + (progress === 40 ? 1 : 2))
      for (let i = 1; i < 3 * n; i++) {
        expect(renders.get(i)).toBe(before.get(i))
      }
    }
    const settled = new Map(renders)
    visits = 0
    normalize.mockClear()
    resolve.mockClear()
    act(() => useAppStore.setState({ sidebarBody: 'workspaces' }))
    expect(visits).toBe(0)
    expect(normalize).not.toHaveBeenCalled()
    expect(resolve.mock.calls.length).toBeLessThanOrEqual(n * 4)
    expect(renders).toEqual(settled)
    write(0, { agentType: 'codex' })
    for (const id of [0, 2 * n]) {
      expect(views.get(id)?.agentType).toBe('codex')
      expect(renders.get(id)).toBe(settled.get(id)! + 1)
    }
    expect(views.get(n)).toEqual({ agentType: 'claude' })
    expect(renders.get(n)).toBe(settled.get(n))
    mounted.unmount()
  }
)

it.each(['run:coordinator', 'dispatch:past'])(
  'never borrows a same-kind successor status for a saved event with only role %s',
  (address) => {
    write(0, { agentType: 'codex' })
    useAppStore.getState().setAgentSenderPublication('local', {
      associations: [
        { identity: address, paneKey: status(0).paneKey, worktreeId: 'workspace' },
        { identity: 'term_0', paneKey: status(0).paneKey, worktreeId: 'workspace' }
      ],
      principals: [],
      attachments: [],
      revision: { epoch: 'successor', revision: 1 }
    })
    const saved = {
      name: 'Known A',
      agent: 'codex',
      party: { address, terminalHandle: null, orcaSessionId: null }
    }
    const past = renderHook(() => useAgentMessageSenderView(saved, 'workspace', { kind: 'local' }))
    const current = renderHook(() =>
      useAgentMessageSenderView(
        {
          name: 'Known B',
          agent: 'codex',
          party: { address: 'term_0', terminalHandle: 'term_0', orcaSessionId: null }
        },
        'workspace',
        { kind: 'local' }
      )
    )
    expect(past.result.current).toEqual({ agentType: 'codex', dot: undefined, progress: undefined })
    expect(current.result.current).toEqual({ agentType: 'codex' })
    write(0, { state: 'waiting' })
    expect(past.result.current).toEqual({ agentType: 'codex', dot: undefined, progress: undefined })
  }
)

it('shows only a proved Dispatch invocation and withdraws proof without changing unrelated sender rows', () => {
  write(0, { agentType: 'codex' })
  const saved = {
    name: 'Worker',
    agent: 'codex' as const,
    party: { address: 'dispatch:worker', terminalHandle: 'term_0', orcaSessionId: null }
  }
  const publish = (proved: boolean, revision: number) =>
    useAppStore.getState().setAgentSenderPublication('local', {
      associations: [
        ...(proved
          ? ['dispatch:worker', 'term_old'].map((identity) => ({
              identity,
              paneKey: status(0).paneKey,
              worktreeId: 'workspace',
              dispatchActor: true as const
            }))
          : []),
        { identity: 'term_0', paneKey: status(0).paneKey, worktreeId: 'workspace' }
      ],
      principals: [],
      attachments: [],
      revision: { epoch: 'proof', revision }
    })
  const other = status(9, 'remote')
  useAppStore.setState({
    repos: [TEST_REPO],
    worktreesByRepo: {
      [TEST_REPO.id]: [
        makeWorktree({ id: 'remote', repoId: TEST_REPO.id, hostId: 'runtime:remote' })
      ]
    },
    tabsByWorktree: {
      ...useAppStore.getState().tabsByWorktree,
      remote: [makeTab({ id: 'tab-9', worktreeId: 'remote' })]
    },
    agentStatusByPaneKey: { ...useAppStore.getState().agentStatusByPaneKey, [other.paneKey]: other }
  })
  render(
    <>
      <Probe id={1} />
      <Probe id={9} workspace="remote" remote />
    </>
  )
  publish(true, 1)
  const ordinary = {
    name: 'Worker',
    agent: 'codex' as const,
    party: { address: 'term_old', terminalHandle: 'term_old', orcaSessionId: null }
  }
  const alias = renderHook(() =>
    useAgentMessageSenderView(ordinary, 'workspace', { kind: 'local' })
  )
  const single = renderHook(() => useAgentMessageSenderView(saved, 'workspace', { kind: 'local' }))
  expect(single.result.current).toMatchObject({ agentType: 'codex', dot: 'working' })
  expect(alias.result.current).toEqual({ agentType: 'codex' })
  const before = new Map(renders)
  act(() => publish(false, 2))
  expect(renders).toEqual(before)
  expect(single.result.current.agentType).toBe('codex')
  expect(single.result.current.dot).toBeUndefined()
  expect(alias.result.current.agentType).toBe('codex')
  expect(alias.result.current.dot).toBeUndefined()
  act(() => publish(false, 3))
  expect(renders).toEqual(before)
  expect(alias.result.current.dot).toBeUndefined()
  // The current terminal alias must not bypass missing source proof.
  write(0, { state: 'waiting' })
  expect(single.result.current.dot).toBeUndefined()
  act(() => publish(true, 4))
  expect(single.result.current).toMatchObject({ agentType: 'codex', dot: 'waiting' })
})

it('never falls from a missing saved session to the later occupant of its handle, while keeping navigation', () => {
  write(0, { agentType: 'codex' })
  const session = parseOrcaSessionAddress('orca_session_id:codex_original_sender')
  if (!session) {
    throw new Error('invalid fixture session')
  }
  const saved = {
    name: 'Original sender',
    agent: 'codex',
    party: { address: 'term_0', terminalHandle: 'term_0', orcaSessionId: session }
  }
  useAppStore.getState().setAgentSenderPublication('local', {
    associations: [
      {
        identity: 'term_0',
        paneKey: status(0).paneKey,
        worktreeId: 'workspace',
        dispatchActor: true
      }
    ],
    principals: [],
    attachments: [],
    revision: { epoch: 'saved-session', revision: 1 }
  })
  const single = renderHook(() => useAgentMessageSenderView(saved, 'workspace', { kind: 'local' }))
  expect(single.result.current).toEqual({ agentType: 'codex' })
  act(() =>
    useAppStore.getState().setAgentSenderPublication('local', {
      associations: [
        {
          identity: `orca_session_id:${session}`,
          sessionId: session,
          paneKey: status(0).paneKey,
          worktreeId: 'workspace'
        }
      ],
      principals: [],
      attachments: [],
      revision: { epoch: 'saved-session', revision: 2 }
    })
  )
  expect(single.result.current).toMatchObject({ agentType: 'codex', dot: 'working' })
})
