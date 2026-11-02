// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type {
  CrewSubscriptionAttemptArgs,
  CrewSubscriptionAttemptCallbacks
} from '../../../../shared/runtime-environment-subscription-setup'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { RuntimeRpcSubscriptionHandlers } from '@/runtime/runtime-rpc-subscribe'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY } from '../../../../shared/protocol-version'
import { useOrchestrationCrew } from './use-orchestration-crew'
import { useAppStore } from '@/store'
import type { OrchestrationCrewFrame } from '../../../../shared/orchestration-crew'
import type { MountedCrewProducerModule } from '../../../../shared/orchestration-crew-mounted.test-fixture'

const rig = vi.hoisted(() => {
  const streams: {
    target: RuntimeClientTarget
    party: string
    handlers: RuntimeRpcSubscriptionHandlers
    unsubscribe: ReturnType<typeof vi.fn>
  }[] = []
  return {
    streams,
    producers: new Map<string, (handlers: RuntimeRpcSubscriptionHandlers) => () => void>(),
    cancellations: new Map<string, () => void>(),
    listeners: new Set<() => void>(),
    state: {
      unusedLocalState: 0,
      runtimeStatusByEnvironmentId: new Map<
        string,
        {
          status: { runtimeId: string; capabilities?: string[] }
          connectionGeneration: number
          hostContactEpoch: number
          snapshot?: {
            environmentId: string
            pairingRevision: number
            sequence: number
            checkedAt: number
            status: { runtimeId: string; capabilities?: string[] }
            verification: string
            transport: string
          }
        }
      >([
        [
          'crew-host',
          { status: { runtimeId: 'runtime-one' }, connectionGeneration: 1, hostContactEpoch: 1 }
        ]
      ])
    }
  }
})
vi.mock('@/runtime/runtime-rpc-subscribe', () => ({
  subscribeRuntimeRpc: vi.fn(
    async (
      target: RuntimeClientTarget,
      _method: string,
      params: { party: string },
      handlers: RuntimeRpcSubscriptionHandlers
    ) => {
      const key = `${target.kind === 'local' ? 'local' : target.environmentId}:${params.party}`
      const stop = rig.producers.get(key)?.(handlers)
      const stream = { target, party: params.party, handlers, unsubscribe: vi.fn(() => stop?.()) }
      rig.streams.push(stream)
      return { unsubscribe: stream.unsubscribe }
    }
  )
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => rig.state,
    subscribe: (wake: () => void) => {
      rig.listeners.add(wake)
      return () => rig.listeners.delete(wake)
    }
  }
}))
beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0)
  Object.assign(window, {
    api: {
      runtimeEnvironments: {
        subscribeCrewAttempt: async (
          args: CrewSubscriptionAttemptArgs,
          callbacks: CrewSubscriptionAttemptCallbacks
        ) => {
          const params = args.params
          if (
            !params ||
            typeof params !== 'object' ||
            !('party' in params) ||
            typeof params.party !== 'string'
          ) {
            throw new Error('Expected party')
          }
          const unsubscribe = vi.fn()
          rig.cancellations.set(args.subscriptionId, unsubscribe)
          rig.streams.push({
            target: { kind: 'environment', environmentId: args.selector },
            party: params.party,
            unsubscribe,
            handlers: {
              onEvent: (value) =>
                callbacks.onResponse({
                  id: args.subscriptionId,
                  ok: true,
                  result: value,
                  _meta: { runtimeId: args.expectedEnvironmentRuntimeId ?? '' }
                }),
              onError: (error) => {
                if (
                  error &&
                  typeof error === 'object' &&
                  'code' in error &&
                  typeof error.code === 'string'
                ) {
                  callbacks.onError?.({ code: error.code, message: '' })
                }
              },
              onClose: () => callbacks.onClose?.()
            }
          })
          return { subscriptionId: args.subscriptionId, ok: true as const }
        },
        cancelSubscription: async ({ subscriptionId }: { subscriptionId: string }) => {
          rig.cancellations.get(subscriptionId)?.()
          rig.cancellations.delete(subscriptionId)
        }
      }
    }
  })
})
afterEach(() => {
  cleanup()
  rig.streams.length = 0
  rig.producers.clear()
  rig.cancellations.clear()
  renderCounts.clear()
  vi.restoreAllMocks()
  vi.useRealTimers()
})
const local = { kind: 'local' } as const
const remote = { kind: 'environment', environmentId: 'crew-host' } as const
const renderCounts = new Map<string, number>()
function Pane({ party, target = local }: { party: string; target?: RuntimeClientTarget }) {
  renderCounts.set(party, (renderCounts.get(party) ?? 0) + 1)
  const crew = useOrchestrationCrew(target, party)
  return (
    <>
      <output data-testid={party}>
        {crew.status === 'ok' ? crew.sections.managing.length : 'unknown'}
      </output>
      <output data-testid={`${party}-address`}>{crew.sections.talkingWith[0]?.sendAddress}</output>
      <output data-testid={`${party}-latest`}>
        {crew.sections.talkingWith[0]?.latest?.preview}
      </output>
      <output data-testid={`${party}-question`}>
        {crew.sections.managing[0]?.pendingQuestion?.preview}
      </output>
    </>
  )
}
function publish(index: number, pending = false) {
  const handlers = rig.streams[index].handlers
  handlers.onEvent({ type: 'begin', status: 'ok' })
  handlers.onEvent({
    type: 'rows',
    section: 'managing',
    rows: [
      {
        partyKey: 'host-worker',
        role: 'worker',
        label: 'Worker',
        agentKind: 'codex',
        status: 'working',
        sendAddress: 'term_worker',
        ...(pending
          ? { pendingQuestion: { preview: 'Which option?', at: new Date(0).toISOString() } }
          : {})
      }
    ]
  })
  return () => handlers.onEvent({ type: 'complete' })
}

it('caches old-host refusal per generation and resubscribes after reconnect or pairing changes', async () => {
  replaceRuntimeEnvironmentRevisions([{ id: 'crew-host', createdAt: 1 }])
  const view = render(<Pane party="term_old" target={remote} />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250)
  })
  act(() => rig.streams[0].handlers.onError({ code: 'method_not_found' }))
  expect(view.getByTestId('term_old').textContent).toBe('unknown')
  view.rerender(<Pane party="term_plain" target={remote} />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250)
  })
  expect(rig.streams).toHaveLength(1)
  act(() => {
    rig.state = {
      ...rig.state,
      runtimeStatusByEnvironmentId: new Map([
        [
          'crew-host',
          {
            status: {
              runtimeId: 'runtime-two',
              capabilities: [REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY]
            },
            connectionGeneration: 2,
            hostContactEpoch: 2,
            snapshot: {
              environmentId: 'crew-host',
              pairingRevision: 1,
              sequence: 1,
              checkedAt: 1,
              status: { runtimeId: 'runtime-two' },
              verification: 'verified',
              transport: 'ready'
            }
          }
        ]
      ])
    }
    rig.listeners.forEach((wake) => wake())
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250)
  })
  expect(rig.streams).toHaveLength(2)
  act(() => publish(1)())
  expect(view.getByTestId('term_plain').textContent).toBe('1')
  act(() => rig.streams[1].handlers.onClose())
  expect(view.getByTestId('term_plain').textContent).toBe('unknown')
  act(() => {
    const entry = rig.state.runtimeStatusByEnvironmentId.get('crew-host')
    if (entry?.snapshot) {
      entry.snapshot.pairingRevision = 2
    }
    replaceRuntimeEnvironmentRevisions([{ id: 'crew-host', createdAt: 1, pairingRevision: 2 }])
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500)
  })
  expect(rig.streams).toHaveLength(3)
  expect(rig.streams[1].unsubscribe).toHaveBeenCalledOnce()
  view.unmount()
  expect(rig.streams[2].unsubscribe).toHaveBeenCalledOnce()
})

let createMountedCrewProducer: MountedCrewProducerModule['createMountedCrewProducer']
beforeAll(async () => {
  const owner = await vi.importActual<MountedCrewProducerModule>(
    '../../../../main/runtime/orchestration/crew/crew-mounted-render.test-fixture'
  )
  createMountedCrewProducer = owner.createMountedCrewProducer
})

it('publishes real no-mail Run/history address changes through CrewReadModel and subscribeCrew to only the selected mounted consumer and renders none for unused store state', async () => {
  const status = {
    snapshot: {
      environmentId: 'crew-other-host',
      pairingRevision: 20,
      sequence: 1,
      checkedAt: 1,
      status: {
        runtimeId: 'runtime-isolation',
        capabilities: [REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY]
      },
      verification: 'verified',
      transport: 'ready'
    },
    status: {
      runtimeId: 'runtime-isolation',
      capabilities: [REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY]
    },
    connectionGeneration: 1,
    hostContactEpoch: 1
  }
  rig.state = {
    unusedLocalState: 0,
    runtimeStatusByEnvironmentId: new Map([
      [
        'crew-host',
        {
          ...status,
          snapshot: { ...status.snapshot, environmentId: 'crew-host', pairingRevision: 10 }
        }
      ],
      ['crew-other-host', status]
    ])
  }
  replaceRuntimeEnvironmentRevisions([
    { id: 'crew-host', createdAt: 10 },
    { id: 'crew-other-host', createdAt: 20 }
  ])
  const localProducer = createMountedCrewProducer()
  const selectedProducer = createMountedCrewProducer()
  const otherProducer = createMountedCrewProducer()
  const parties = ['term_worker', 'term_helper', 'term_selected_address', 'term_other_address']
  const counts = () => parties.map((party) => renderCounts.get(party) ?? 0)
  const deliveries = new Map<string, OrchestrationCrewFrame[]>()
  for (const [key, producer, party] of [
    ['local:term_worker', localProducer, 'term_worker'],
    ['local:term_helper', localProducer, 'term_helper'],
    ['crew-host:term_selected_address', selectedProducer, 'term_worker'],
    ['crew-other-host:term_other_address', otherProducer, 'term_worker']
  ] as const) {
    rig.producers.set(key, (handlers) =>
      producer.subscribe(party, (frame) => {
        const frames = deliveries.get(key) ?? []
        frames.push(frame)
        deliveries.set(key, frames)
        handlers.onEvent(frame)
      })
    )
  }
  const otherHost = { kind: 'environment', environmentId: 'crew-other-host' } as const
  const view = render(
    <>
      <Pane party="term_worker" />
      <Pane party="term_helper" />
      <Pane party="term_selected_address" target={remote} />
      <Pane party="term_other_address" target={otherHost} />
    </>
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250)
  })
  expect(rig.streams).toHaveLength(4)
  expect(view.getByTestId('term_worker-address').textContent).toBe(localProducer.address)
  expect(view.getByTestId('term_selected_address-address').textContent).toBe(
    selectedProducer.address
  )
  expect(view.getByTestId('term_other_address-address').textContent).toBe(otherProducer.address)
  expect(view.getByTestId('term_worker-latest').textContent).toBe('Retained L')
  // Each initial stream emits one atomic begin/rows/complete replacement.
  expect(deliveries.get('local:term_worker')?.map((frame) => frame.type)).toEqual([
    'begin',
    'rows',
    'complete'
  ])
  renderCounts.clear()
  const sourceReads = vi.spyOn(useAppStore, 'getState')
  act(() => {
    rig.state = { ...rig.state, unusedLocalState: 1 }
    rig.listeners.forEach((wake) => wake())
  })
  expect(counts()).toEqual([0, 0, 0, 0])
  expect(sourceReads).toHaveBeenCalledTimes(2)
  await act(async () => {
    localProducer.removeAddress()
    await vi.runAllTicks()
  })
  expect(view.getByTestId('term_worker-address').textContent).toBe('')
  expect(view.getByTestId('term_worker-latest').textContent).toBe('Retained L')
  expect(counts()).toEqual([1, 0, 0, 0])
  renderCounts.clear()
  await act(async () => {
    otherProducer.removeAddress()
    await vi.runAllTicks()
  })
  expect(view.getByTestId('term_other_address-address').textContent).toBe('')
  expect(view.getByTestId('term_selected_address-address').textContent).toBe(
    selectedProducer.address
  )
  expect(counts()).toEqual([0, 0, 0, 1])
  view.unmount()
  expect(rig.streams.every((stream) => stream.unsubscribe.mock.calls.length === 1)).toBe(true)
})
