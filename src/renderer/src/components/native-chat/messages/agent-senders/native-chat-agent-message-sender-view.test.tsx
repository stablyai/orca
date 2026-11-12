import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { render } from '../actions/native-chat-tooltip-test-harness'
import { useAppStore } from '@/store'
import { makeTab } from '@/store/terminals/terminal-tab.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import { parseOrcaSessionAddress } from '../../../../../../shared/orca-session-address'
import '@/components/sidebar/workspace-card/activity/worktree-agent-row-selectors'
import { useAgentMessageSenderView } from './native-chat-agent-message-sender-view'
import { initialStore, status, resetSenderStore } from './native-chat-agent-sender.test-fixture'

const renders = new Map<number, number>()
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
  useAgentMessageSenderView(
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
      agentStatusByPaneKey: acceptedAgentStatuses([
        ...state.agentStatusByPaneKey,
        [key, { ...state.agentStatusByPaneKey.get(key)!, ...update }] satisfies [
          string,
          AgentStatusEntry
        ]
      ]),
      agentStatusEpoch: state.agentStatusEpoch + 1
    })
  )
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(2_000_000)
  renders.clear()
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
    agentStatusByPaneKey: acceptedAgentStatuses([
      ...useAppStore.getState().agentStatusByPaneKey,
      [other.paneKey, other] as const
    ])
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
