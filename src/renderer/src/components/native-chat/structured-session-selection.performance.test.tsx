// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createStructuredSessionSelectionController } from '../../../../shared/structured-agent-session-selection-operations'
import { useStructuredSessionSelectionReads } from './use-structured-session-selection-reads'
import { useStructuredAgentSessionOptionStamp } from './structured-agent-session-status-hooks'
import { useAppStore } from '@/store'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import type * as StructuredClient from '@/runtime/structured-agent-session-client'
import type { AgentSessionStatusEvent } from '../../../../shared/agent-session-wire'
import {
  getStructuredAgentSessionStatusFeed,
  resetStructuredAgentSessionStatusFeedsForTests
} from '@/runtime/structured-agent-session-status-feed'

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(),
  runtimeEnvironmentSupportsCapability: vi.fn(async () => true)
}))
const handOffTransport = vi.hoisted(() => ({ subscribe: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-client', async (importOriginal) => ({
  ...(await importOriginal<typeof StructuredClient>()),
  subscribeStructuredAgentSessionStatus: handOffTransport.subscribe,
  supportsStructuredAgentSessionContinuationContext: vi.fn(async () => false)
}))

const initialState = useAppStore.getState()
afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
  resetStructuredAgentSessionStatusFeedsForTests()
  handOffTransport.subscribe.mockReset()
})

it('bounds the actual pick/read/overlay path at 10 and 100 delayed writes without whole-drain joins', async () => {
  const measurements: {
    count: number
    sends: number
    renders: number
    visits: number
    memberships: number
  }[] = []
  const target = { kind: 'local' } as const
  for (const count of [10, 100]) {
    const controller = createStructuredSessionSelectionController(vi.fn())
    const replies = Array.from({ length: count }, () =>
      Promise.withResolvers<{
        kind: 'accepted'
        options: Record<string, string>
      }>()
    )
    const reread = vi.fn()
    const capture = vi.spyOn(controller, 'captureRead')
    let renders = 0
    let visits = 0
    let sends = 0
    let memberships = 0
    const all = Promise.all.bind(Promise)
    const join = vi.spyOn(Promise, 'all').mockImplementation((values) => {
      const entries = Array.from(values)
      memberships += entries.length
      return all(entries)
    })
    function Probe() {
      useStructuredSessionSelectionReads({
        controller,
        target,
        authority: 'local',
        hostOptionStamp: '',
        turnId: null,
        rereadOptions: reread
      })
      controller.overlay()
      controller.isPending('model')
      controller.pendingId()
      renders++
      return null
    }
    const view = render(<Probe />)
    const baseline = renders
    for (let index = 0; index < count; index++) {
      act(() => {
        const operation = controller.issue('model', index % 2 ? 'sonnet' : 'opus', null)
        for (const key of ['identity', 'key', 'transmitted', 'outcome'] as const) {
          let value = operation[key]
          Object.defineProperty(operation, key, {
            configurable: true,
            get() {
              visits++
              return value
            },
            set(next) {
              value = next
            }
          })
        }
        controller.flush(() => {
          sends++
          return replies[index].promise
        })
      })
    }
    join.mockRestore()
    expect(sends).toBe(count)
    expect(renders - baseline).toBe(count)
    expect(memberships).toBe(0)
    expect(visits).toBeLessThanOrEqual(40 * count)
    expect(capture).not.toHaveBeenCalled()
    expect(reread).not.toHaveBeenCalled()
    measurements.push({ count, sends, renders: renders - baseline, visits, memberships })
    await act(async () =>
      replies[count - 1].resolve({ kind: 'accepted', options: { model: 'sonnet' } })
    )
    expect(reread).toHaveBeenCalledTimes(1)
    const captured = controller.captureRead()
    await act(async () => replies[1].resolve({ kind: 'accepted', options: { model: 'sonnet' } }))
    expect(reread).toHaveBeenCalledTimes(2)
    act(() => controller.retire(captured))
    expect(controller.captureRead()).toEqual([2])
    expect(controller.overlay()).toEqual({})
    const draining = controller.drain()
    act(() => controller.abandon())
    await draining
    for (const reply of replies) {
      reply.resolve({ kind: 'accepted', options: { model: 'opus' } })
    }
    await act(async () => {
      await Promise.resolve()
    })
    expect(controller.overlay()).toEqual({})
    view.unmount()
  }
  expect(measurements[1].visits).toBeLessThanOrEqual(measurements[0].visits * 11)
  console.info('selection-pick-upstream-work', JSON.stringify(measurements))
})

it('keeps unrelated store, same-host status and other-host consumers quiet at N and 10N', async () => {
  for (const count of [10, 100]) {
    const emits = new Map<string, (event: AgentSessionStatusEvent) => void>()
    handOffTransport.subscribe.mockImplementation(async (target, emit) => {
      emits.set(target.kind === 'local' ? 'local' : target.environmentId, emit)
      return { unsubscribe: vi.fn() }
    })
    const target = { kind: 'local' } as const
    const feed = getStructuredAgentSessionStatusFeed(target)
    const snapshot = vi.spyOn(feed, 'getSnapshot')
    const other = getStructuredAgentSessionStatusFeed({
      kind: 'environment',
      environmentId: 'other'
    })
    const controllers = Array.from({ length: count }, () =>
      createStructuredSessionSelectionController(vi.fn())
    )
    const renders = Array.from({ length: count }, () => 0)
    const rereads = controllers.map(() => vi.fn())
    function Probe({ index }: { index: number }) {
      const stamp = useStructuredAgentSessionOptionStamp(`session-${index}`, target)
      useStructuredSessionSelectionReads({
        controller: controllers[index],
        target,
        authority: 'local',
        hostOptionStamp: stamp,
        turnId: null,
        rereadOptions: rereads[index]
      })
      renders[index]++
      return null
    }
    const view = render(controllers.map((_, index) => <Probe key={index} index={index} />))
    let stop = () => {}
    await act(async () => {
      stop = other.activate()
    })
    const baseline = [...renders]
    const publish = (host: string, sessionId: string, model: string) => {
      const emit = emits.get(host)
      if (!emit) {
        throw new Error('Missing test status transport')
      }
      act(() =>
        emit({
          type: 'snapshot',
          sessions: [
            {
              sessionId,
              workspaceId: 'wt-1',
              agent: 'codex',
              status: 'idle',
              latestPrompt: 'hello',
              updatedAt: 1,
              effort: model
            }
          ]
        })
      )
    }
    snapshot.mockClear()
    act(() => useAppStore.setState({ lastTerminalInputAtByPaneKey: { other: 1 } }))
    expect(snapshot).not.toHaveBeenCalled()
    publish('other', 'session-0', 'other-model')
    expect(snapshot).not.toHaveBeenCalled()
    publish('local', 'unmounted', 'unrelated-model')
    const upstreamReads = snapshot.mock.calls.length
    expect(upstreamReads).toBeGreaterThanOrEqual(count)
    expect(upstreamReads).toBeLessThanOrEqual(count * 3)
    expect(renders).toEqual(baseline)
    publish('local', 'session-0', 'sonnet')
    expect(renders).toEqual(baseline.map((value, index) => value + (index === 0 ? 1 : 0)))
    expect(rereads[0]).toHaveBeenCalledTimes(1)
    const beforePick = [...renders]
    act(() => controllers[1].issue('model', 'opus', null))
    expect(renders).toEqual(beforePick.map((value, index) => value + (index === 1 ? 1 : 0)))
    console.info(
      'selection-status-upstream-work',
      JSON.stringify({ count, upstreamReads, unrelatedRenders: 0 })
    )
    view.unmount()
    stop()
    snapshot.mockRestore()
    resetStructuredAgentSessionStatusFeedsForTests()
  }
})

it('bounds selected continuity wakes and keeps other-host consumers quiet at N and 10N', () => {
  for (const count of [10, 100]) {
    const targets = Array.from({ length: count }, (_, index) => ({
      kind: 'environment' as const,
      environmentId: index % 2 ? 'continuity-other' : 'continuity-selected'
    }))
    const controllers = targets.map(() => createStructuredSessionSelectionController(vi.fn()))
    const reads = targets.map(() => vi.fn())
    const renders = targets.map(() => 0)
    function Probe({ index }: { index: number }) {
      useStructuredSessionSelectionReads({
        controller: controllers[index],
        target: targets[index],
        authority: '',
        hostOptionStamp: '',
        turnId: null,
        rereadOptions: reads[index]
      })
      renders[index]++
      return null
    }
    const environments = targets
      .slice(0, 2)
      .map((target) => ({ id: target.environmentId, createdAt: 1, pairingRevision: 2 }))
    replaceRuntimeEnvironmentRevisions(environments, {
      retired: [],
      sameHost: [],
      pending: [{ id: 'continuity-selected', fromRevision: 1 }]
    })
    const view = render(targets.map((_, index) => <Probe key={index} index={index} />))
    const baseline = [...renders]
    const projectionReads = vi.spyOn(useAppStore.getState().runtimeStatusByEnvironmentId, 'get')
    act(() => useAppStore.setState({ lastTerminalInputAtByPaneKey: { other: count } }))
    expect(projectionReads).not.toHaveBeenCalled()
    const publishCatalog = () =>
      useAppStore.setState({ runtimeEnvironments: [...useAppStore.getState().runtimeEnvironments] })
    act(publishCatalog)
    expect(renders).toEqual(baseline)
    expect(projectionReads.mock.calls.length).toBeLessThanOrEqual(2 * count)
    replaceRuntimeEnvironmentRevisions(environments, {
      retired: [],
      sameHost: [{ id: 'continuity-selected', fromRevision: 1, toRevision: 2 }]
    })
    act(publishCatalog)
    expect(renders).toEqual(baseline.map((value, index) => value + (index % 2 ? 0 : 1)))
    expect(reads.map((read) => read.mock.calls.length)).toEqual(
      targets.map((_, index) => (index % 2 ? 0 : 1))
    )
    console.info(
      'selection-continuity-work',
      JSON.stringify({
        count,
        projectionReads: projectionReads.mock.calls.length,
        otherHostRenders: 0
      })
    )
    view.unmount()
    projectionReads.mockRestore()
  }
  replaceRuntimeEnvironmentRevisions([])
})
