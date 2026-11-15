// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  acceptedAgentStatuses,
  AcceptedAgentStatuses
} from '@/store/slices/agent-status/accepted-agent-statuses'
import { StarNagAgentValueMomentObserver } from './StarNagAgentValueMomentObserver'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
const original = useAppStore.getState()
const originalApi = window.api
const KEY = 'nag-tab:11111111-1111-4111-8111-111111111111'
let root: ReturnType<typeof createRoot>

function entry(
  state: AgentStatusEntry['state'],
  extra: Partial<AgentStatusEntry> = {}
): AgentStatusEntry {
  return {
    paneKey: KEY,
    state,
    agentType: 'claude',
    prompt: 'Complete the task',
    updatedAt: 1_000,
    stateStartedAt: 1_000,
    stateHistory: [],
    ...extra
  }
}
function replace(row: AgentStatusEntry) {
  useAppStore.setState({ agentStatusByPaneKey: acceptedAgentStatuses([[KEY, row]]) })
}
const prepare = vi.fn()
const show = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(2_000)
  prepare.mockReset().mockResolvedValue({ status: 'ready' })
  show.mockReset().mockResolvedValue(undefined)
  Reflect.set(window, 'api', {
    ...originalApi,
    starNag: { agentValueMoment: prepare, showAgentValueMoment: show }
  })
  useAppStore.setState({ agentStatusByPaneKey: acceptedAgentStatuses() })
  root = createRoot(document.createElement('div'))
})
afterEach(() => {
  act(() => root.unmount())
  vi.restoreAllMocks()
  Reflect.set(window, 'api', originalApi)
  useAppStore.setState(original, true)
  vi.useRealTimers()
})

it('observes committed completion, including a bulk replacement, without replaying initial Done', async () => {
  replace(entry('done'))
  act(() => root.render(<StarNagAgentValueMomentObserver />))
  await act(async () => vi.runOnlyPendingTimersAsync())
  expect(prepare).not.toHaveBeenCalled()
  act(() => replace(entry('working')))
  act(() => replace(entry('done', { stateStartedAt: 2_000 })))
  await act(async () => vi.runOnlyPendingTimersAsync())
  expect(prepare).toHaveBeenCalledOnce()
  expect(show).toHaveBeenCalledOnce()
})

it('keeps completion batches ordered under reentry and publishes neither views nor transitions on abort', () => {
  replace(entry('working'))
  const owner = () => useAppStore.getState().agentStatusByPaneKey
  const projection = owner().projection
  const transitions: string[] = []
  const stop = projection.subscribeTransitions((changes) => {
    for (const change of changes) {
      if (change.paneKey !== KEY) {
        continue
      }
      transitions.push(`${change.previous?.state}->${change.current?.state}`)
      if (change.current?.state === 'done') {
        replace(entry('working', { stateStartedAt: 3_000 }))
      }
    }
  })
  try {
    expect(() =>
      useAppStore.getState().transactAgentStatuses((transaction) => {
        transaction.apply({
          paneKey: KEY,
          payload: { state: 'done', agentType: 'codex', prompt: 'Aborted' }
        })
        throw new Error('abort')
      })
    ).toThrow('abort')
    expect(transitions).toEqual([])
    expect(projection.hasActiveAgents()).toBe(true)
    expect(projection.terminalLeafAgentTypes('nag-tab')).toEqual({
      '11111111-1111-4111-8111-111111111111': 'claude'
    })
    replace(entry('done', { stateStartedAt: 2_000 }))
    expect(transitions).toEqual(['working->done', 'done->working'])
    expect(projection.hasActiveAgents()).toBe(true)
  } finally {
    stop()
  }
})

it.each([
  { sessionBoundary: true },
  { interrupted: true },
  { stateStartedAt: 500 },
  { prompt: '', stateHistory: [] }
])('does not announce an ineligible Done transition %j', async (extra) => {
  replace(entry('working'))
  act(() => root.render(<StarNagAgentValueMomentObserver />))
  act(() => replace(entry('done', extra)))
  await act(async () => vi.runOnlyPendingTimersAsync())
  expect(prepare).not.toHaveBeenCalled()
  expect(show).not.toHaveBeenCalled()
})

it.each([100, 1000])(
  'checks exact active state without fleet reads at %i rows, including during preparation',
  async (count) => {
    const activeKey = 'unplaced:active'
    useAppStore.setState({
      agentStatusByPaneKey: acceptedAgentStatuses([
        [KEY, entry('working')],
        [
          activeKey,
          {
            ...entry('working', { paneSleep: { ptyId: 'sleeping-unfinished' } }),
            paneKey: activeKey
          }
        ],
        ...Array.from({ length: count }, (_, i): readonly [string, AgentStatusEntry] => [
          `other-${i}:leaf`,
          { ...entry('done'), paneKey: `other-${i}:leaf` }
        ])
      ])
    })
    act(() => root.render(<StarNagAgentValueMomentObserver />))
    useAppStore.getState().scheduleAgentStatusFreshness()
    const entries = vi.spyOn(AcceptedAgentStatuses.prototype, 'entries')
    const values = vi.spyOn(AcceptedAgentStatuses.prototype, 'values')
    const capture = vi.spyOn(AcceptedAgentStatuses.prototype, 'capture')
    const status = (key: string, state: AgentStatusEntry['state']) =>
      useAppStore.getState().setAgentStatus(key, { state, prompt: 'Task' }, undefined, {
        updatedAt: 3_000,
        stateStartedAt: 3_000
      })
    act(() => status(KEY, 'done'))
    await act(async () => vi.runOnlyPendingTimersAsync())
    expect(prepare).not.toHaveBeenCalled()
    let finish: (value: { status: 'ready' }) => void = () => {}
    prepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    act(() => useAppStore.getState().dropAgentStatus(activeKey))
    await act(async () => vi.runOnlyPendingTimersAsync())
    expect(prepare).toHaveBeenCalledOnce()
    act(() => status(activeKey, 'blocked'))
    await act(async () => {
      finish({ status: 'ready' })
    })
    expect(show).not.toHaveBeenCalled()
    act(() => useAppStore.getState().dropAgentStatus(activeKey))
    await act(async () => vi.runOnlyPendingTimersAsync())
    expect(show).toHaveBeenCalledOnce()
    expect(entries).not.toHaveBeenCalled()
    expect(values).not.toHaveBeenCalled()
    expect(capture).not.toHaveBeenCalled()
  }
)
