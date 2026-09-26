import { describe, expect, it, vi } from 'vitest'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import {
  createRuntimeClientEventsSync,
  type RuntimeClientEventSubscriptionHandle
} from './runtime-client-events-sync'

function makeHarness() {
  let desired = ['A', 'B']
  let key = 'A:1'
  const records: {
    environmentId: string
    emit: () => void
    resolve: () => void
    reject: () => void
    unsubscribe: ReturnType<typeof vi.fn>
  }[] = []
  const onEvent = vi.fn()
  const manager = createRuntimeClientEventsSync({
    getDesiredEnvironmentIds: () => desired,
    getSubscriptionKey: (id) => (id === 'A' ? key : id),
    subscribe: (environmentId, notify) => {
      const pending = Promise.withResolvers<RuntimeClientEventSubscriptionHandle>()
      const unsubscribe = vi.fn()
      const event: RuntimeClientEvent = { type: 'reposChanged' }
      records.push({
        environmentId,
        emit: () => notify(event),
        resolve: () => pending.resolve({ unsubscribe }),
        reject: () => pending.reject(new Error('setup failed')),
        unsubscribe
      })
      notify(event)
      return pending.promise
    },
    onEvent
  })
  return {
    manager,
    onEvent,
    records,
    setDesired: (next: string[]) => {
      desired = next
    },
    rekey: () => {
      key = 'A:2'
    }
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve()
  }
}

describe('runtime event subscription ownership', () => {
  it('preserves a new owner started synchronously by the last initial frame', async () => {
    let desired = ['A']
    const records: {
      emit: () => void
      setup: ReturnType<typeof Promise.withResolvers<RuntimeClientEventSubscriptionHandle>>
      unsubscribe: ReturnType<typeof vi.fn<() => void>>
    }[] = []
    const onEvent = vi.fn((id: string) => {
      if (id === 'A') {
        manager.stop()
        desired = ['B']
        manager.sync()
      }
    })
    const manager = createRuntimeClientEventsSync({
      getDesiredEnvironmentIds: () => desired,
      subscribe: (_id, notify) => {
        const setup = Promise.withResolvers<RuntimeClientEventSubscriptionHandle>()
        const unsubscribe = vi.fn()
        const emit = (): void => notify({ type: 'reposChanged' })
        records.push({ emit, setup, unsubscribe })
        emit()
        return setup.promise
      },
      onEvent
    })
    manager.sync()
    onEvent.mockClear()
    records[0].emit()
    records[1].emit()
    expect(onEvent.mock.calls.map(([id]) => id)).toEqual(['B'])
    records.forEach(({ setup, unsubscribe }) => setup.resolve({ unsubscribe }))
    await settle()
    expect(records[0].unsubscribe).toHaveBeenCalledOnce()
    expect(records[1].unsubscribe).not.toHaveBeenCalled()
    manager.stop()
  })

  it('stops starting further subscriptions when an initial frame synchronously stops the owner', async () => {
    const pending = Promise.withResolvers<RuntimeClientEventSubscriptionHandle>()
    const unsubscribe = vi.fn()
    const subscribe = vi.fn((_id: string, notify: (event: RuntimeClientEvent) => void) => {
      notify({ type: 'reposChanged' })
      return pending.promise
    })
    const manager = createRuntimeClientEventsSync({
      getDesiredEnvironmentIds: () => ['A', 'B'],
      subscribe,
      onEvent: () => manager.stop()
    })
    manager.sync()
    expect(subscribe).toHaveBeenCalledOnce()
    pending.resolve({ unsubscribe })
    await settle()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('admits synchronous initial frames, pending frames and settled live frames', async () => {
    const h = makeHarness()
    h.manager.sync()
    expect(h.onEvent).toHaveBeenCalledTimes(2)
    h.records[0].emit()
    h.records[0].resolve()
    await settle()
    h.records[0].emit()
    expect(h.onEvent).toHaveBeenCalledTimes(4)
    h.manager.stop()
  })

  it('drops pending and settled callbacks after stop and releases the late handle', async () => {
    const h = makeHarness()
    h.manager.sync()
    h.records[1].resolve()
    await settle()
    h.manager.stop()
    h.onEvent.mockClear()
    h.records.forEach((record) => record.emit())
    expect(h.onEvent).not.toHaveBeenCalled()
    h.records[0].resolve()
    await settle()
    h.records.forEach((record) => expect(record.unsubscribe).toHaveBeenCalledOnce())
  })

  it.each([false, true])(
    'drops a replaced owner while another host stays live (settled=%s)',
    async (settled) => {
      const h = makeHarness()
      h.manager.sync()
      h.records[1].resolve()
      if (settled) {
        h.records[0].resolve()
      }
      await settle()
      h.setDesired(['B'])
      h.manager.sync()
      h.setDesired(['A', 'B'])
      h.manager.sync()
      h.onEvent.mockClear()
      h.records[0].emit()
      h.records[1].emit()
      h.records[2].emit()
      expect(h.onEvent.mock.calls.map(([id]) => id)).toEqual(['B', 'A'])
      h.records[0].resolve()
      h.records[2].resolve()
      await settle()
      expect(h.records[0].unsubscribe).toHaveBeenCalledOnce()
      expect(h.records[2].unsubscribe).not.toHaveBeenCalled()
      h.manager.stop()
    }
  )

  it('rejects callbacks from the old key and admits its replacement before setup completes', async () => {
    const h = makeHarness()
    h.manager.sync()
    h.rekey()
    h.manager.sync()
    h.onEvent.mockClear()
    h.records[0].emit()
    h.records[2].emit()
    expect(h.onEvent).toHaveBeenCalledTimes(1)
    h.records[0].resolve()
    h.records[2].resolve()
    await settle()
    expect(h.records[0].unsubscribe).toHaveBeenCalledOnce()
    h.manager.stop()
  })

  it('permits restarting after stop without reviving the old callback', () => {
    const h = makeHarness()
    h.manager.sync()
    h.manager.stop()
    h.manager.sync()
    h.onEvent.mockClear()
    h.records[0].emit()
    h.records[2].emit()
    expect(h.onEvent).toHaveBeenCalledTimes(1)
    h.manager.stop()
  })

  it('drops callbacks from a rejected setup while retry is waiting', async () => {
    const h = makeHarness()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      h.manager.sync()
      h.records[0].reject()
      await settle()
      h.onEvent.mockClear()
      h.records[0].emit()
      expect(h.onEvent).not.toHaveBeenCalled()
    } finally {
      h.manager.stop()
      warning.mockRestore()
    }
  })

  it('revokes an owner before its unsubscribe callback can reenter delivery', async () => {
    const h = makeHarness()
    h.manager.sync()
    h.records[0].resolve()
    await settle()
    h.records[0].unsubscribe.mockImplementation(h.records[0].emit)
    h.onEvent.mockClear()
    h.setDesired(['B'])
    h.manager.sync()
    expect(h.onEvent).not.toHaveBeenCalled()
    h.manager.stop()
  })
})
