// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { render } from './native-chat-tooltip-test-harness'
import { useAppStore } from '@/store'
import { makeTab, makeWorktree, TEST_REPO } from '@/store/slices/store-test-helpers'
import { readStoreListenerCount } from '@/store/store-listener-census'
import { getKnownExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { resolveStructuredAgentSessionOwner } from '@/runtime/structured-agent-session-owner'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { AgentMessageSenderView } from '../../../../shared/agent-session/agent-message-presentation'
import { runtimeEnvironmentStatusFromSnapshot } from '../../../../shared/runtime-host-status'
import * as presentation from '@/lib/program-status/agent-row-presentation'
import * as cache from '@/components/dashboard/worktree-agent-rows-cache'
import * as selectors from '@/components/sidebar/worktree-agent-row-selectors'
import { useAgentMessageSenderView } from './native-chat-agent-message-sender-view'
import { useAgentMessageSenderSource } from './native-chat-agent-message-sender-source'
import { AgentStateDot } from '@/components/AgentStateDot'
import {
  initialStore,
  LEAF,
  from,
  status,
  resetSenderStore
} from './native-chat-agent-sender.test-fixture'

const renders = new Map<number, number>()
const views = new Map<number, AgentMessageSenderView>()
function Probe({
  id,
  workspace = 'workspace',
  remote = false
}: {
  id: number
  workspace?: string
  remote?: boolean
}) {
  const value = useAgentMessageSenderView(
    {
      party: { address: `term_${id}`, terminalHandle: `term_${id}`, orcaSessionId: null },
      name: 'Sender'
    },
    workspace,
    remote ? { kind: 'environment', environmentId: 'remote' } : { kind: 'local' }
  )
  views.set(id, value)
  renders.set(id, (renders.get(id) ?? 0) + 1)
  return null
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
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initialStore, true)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it.each([100, 1000])(
  'shares actual row acquisition and isolates selected progress across %i cards',
  (n) => {
    let visits = 0
    const live = new Proxy(
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => {
          const entry = status(i)
          return [entry.paneKey, entry]
        })
      ),
      {
        ownKeys(target) {
          const keys = Object.getOwnPropertyNames(target)
          visits += keys.length
          return keys
        }
      }
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
    const normalize = vi.spyOn(presentation, 'resolveRowProgramStatus')
    const mounted = render(
      <>
        {Array.from({ length: n }, (_, id) => (
          <Probe key={id} id={id} />
        ))}
      </>
    )
    // Handle lookup, visible-authority acquisition and sidebar indexing each enumerate the N live entries.
    expect(visits).toBe(n * 3)
    expect(normalize).toHaveBeenCalledTimes(n)
    for (let i = 0; i < n; i++) {
      expect(views.get(i)?.dot).toBe('working')
    }
    const before = new Map(renders)
    visits = 0
    normalize.mockClear()
    act(() => useAppStore.setState({ sidebarBody: 'agents' }))
    expect(visits).toBe(0)
    expect(normalize).not.toHaveBeenCalled()
    expect(renders).toEqual(before)
    for (const progress of [40, 60]) {
      normalize.mockClear()
      const epoch = useAppStore.getState().agentStatusEpoch
      act(() =>
        useAppStore.getState().setAgentProgramStatus(status(0).paneKey, {
          state: 'working',
          progress,
          observedAt: 2_000_000
        })
      )
      expect(useAppStore.getState().agentStatusEpoch).toBe(epoch)
      expect(normalize).toHaveBeenCalledTimes(n)
      expect(views.get(0)?.progress).toBe(progress)
      expect(renders.get(0)).toBe(before.get(0)! + (progress === 40 ? 1 : 2))
      for (let i = 1; i < n; i++) {
        expect(renders.get(i)).toBe(before.get(i))
      }
    }
    mounted.unmount()
  }
)

it('keeps other hosts isolated, retains completed senders, and releases disconnected subscriptions', () => {
  const create = vi.spyOn(cache, 'createWorktreeAgentRowsCache')
  const baseline = readStoreListenerCount()
  expect(baseline).not.toBeNull()
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
  const mounted = render(
    <>
      <Probe id={0} />
      <Probe id={9} workspace="remote" remote />
    </>
  )
  expect(readStoreListenerCount()).toBeGreaterThan(baseline!)
  const leased = create.mock.results.flatMap((result) =>
    result.type === 'return' && result.value.byWorktree.size ? [result.value] : []
  )
  expect(leased.flatMap((value) => [...value.byWorktree.keys()]).sort()).toEqual([
    'remote',
    'workspace'
  ])
  const before = new Map(renders)
  write(9, { state: 'waiting' })
  expect(views.get(9)?.dot).toBe('waiting')
  expect(renders.get(9)).toBe(before.get(9)! + 1)
  expect(renders.get(0)).toBe(before.get(0))
  write(0, {
    agentType: 'codex',
    programStatus: { state: 'blocked', progress: 60, observedAt: 2_000_000 }
  })
  expect(views.get(0)).toEqual({ agentType: 'codex', dot: 'permission', progress: 60 })
  expect(renders.get(9)).toBe(before.get(9)! + 1)
  for (const value of leased) {
    expect(value.lastComputedWorktreeIds.length).toBeLessThanOrEqual(1)
  }
  const entry = { ...status(0), state: 'done' as const }
  act(() =>
    useAppStore.setState({
      agentStatusByPaneKey: { [other.paneKey]: other },
      retainedAgentsByPaneKey: {
        [entry.paneKey]: {
          entry,
          tab: makeTab({ id: 'tab-0', worktreeId: 'workspace' }),
          worktreeId: 'workspace',
          agentType: 'claude',
          startedAt: 1
        }
      },
      runtimeStatusByEnvironmentId: new Map([
        [
          'remote',
          runtimeEnvironmentStatusFromSnapshot({
            environmentId: 'remote',
            pairingRevision: 1,
            sequence: 1,
            checkedAt: 1,
            verification: 'blocked',
            transport: 'disconnected',
            retired: true,
            status: null
          })
        ]
      ])
    })
  )
  expect(views.get(0)?.dot).toBe('done')
  act(() => useAppStore.setState({ activeWorkspaceExecutionHostId: 'runtime:remote' }))
  expect(views.get(0)).toEqual({})
  act(() => useAppStore.setState({ activeWorkspaceExecutionHostId: 'local' }))
  expect(views.get(0)?.dot).toBe('done')
  const disconnected = new Map(renders)
  const constructions = create.mock.calls.length
  act(() => useAppStore.setState({ sidebarBody: 'agents' }))
  expect(renders).toEqual(disconnected)
  expect(create).toHaveBeenCalledTimes(constructions)
  mounted.unmount()
  for (const value of leased) {
    expect(value.byWorktree.size).toBe(0)
  }
  expect(readStoreListenerCount()).toBe(baseline)
  render(<Probe id={0} />)
  expect(views.get(0)?.dot).toBe('done')
})

it('uses the child row own glyph even when its parent program needs permission', () => {
  write(0, {
    programStatus: { state: 'blocked', progress: 60, observedAt: 2_000_000 },
    subagents: [{ id: 'child', state: 'working', startedAt: 2_000_000, description: 'Child' }]
  })
  const state = useAppStore.getState()
  const projected = cache.selectWorktreeAgentRowsCached({
    state,
    worktreeId: 'workspace',
    now: 2_000_000,
    generation: '',
    orchestration: selectors.selectRuntimeAgentOrchestrationForWorktree(state, 'workspace')
  })
  const child = projected.find((row) => row.childRow)!
  expect(child).toBeDefined()
  const locate = () => ({ host: 'local', worktreeId: 'workspace', paneKey: child.paneKey })
  let value: AgentMessageSenderView | undefined
  function Child() {
    value = useAgentMessageSenderSource(locate)
    return value.dot ? (
      <AgentStateDot state={value.dot} progress={value.progress} size="md" title={null} />
    ) : null
  }
  render(<Child />)
  expect(value?.dot).toBe('working')
  expect(value?.progress).toBeUndefined()
  expect(screen.queryByRole('progressbar')).toBeNull()
  expect(screen.getByLabelText('Working')).toBeDefined()
})

it('refuses a target-less ambiguous workspace twin while an explicit local target resolves', () => {
  const workspace = `${TEST_REPO.id}::/w`
  const entry = status(0, workspace)
  useAppStore.setState({
    repos: [TEST_REPO],
    activeWorktreeId: 'different',
    activeWorkspaceExecutionHostId: 'local',
    detectedWorktreesByRepo: {},
    worktreesByRepo: {
      [TEST_REPO.id]: [
        makeWorktree({ id: workspace, repoId: TEST_REPO.id, hostId: 'local' }),
        makeWorktree({ id: workspace, repoId: TEST_REPO.id, hostId: 'runtime:e' })
      ]
    },
    tabsByWorktree: { [workspace]: [makeTab({ id: 'tab-0', worktreeId: workspace })] },
    agentStatusByPaneKey: { [entry.paneKey]: entry }
  })
  const state = useAppStore.getState()
  expect(getKnownExecutionHostIdForWorktree(state, workspace)).toBe('local')
  expect(resolveStructuredAgentSessionOwner(state, workspace)).toBeNull()
  const view = renderHook(() => useAgentMessageSenderView(from.senders[0], workspace))
  expect(view.result.current).toEqual({})
  view.unmount()
  const explicit = renderHook(() =>
    useAgentMessageSenderView(from.senders[0], workspace, { kind: 'local' })
  )
  expect(explicit.result.current.dot).toBe('working')
})
