import { expect, it, vi } from 'vitest'
import { makeAutomation, makeRun } from '@/components/automations/automations-page-fixtures'
import type { AutomationReceiptRead } from '../../../../shared/automations/automation-receipt-read'
import type { AutomationRun } from '../../../../shared/automations/history/automation-run'
import { AutomationCardDetailsController } from './automation-card-details-controller'

vi.mock('@/components/automations/hosts/automation-capability-probe', () => ({
  prepareAutomationLaunchSetup: () => {}
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ runtimeStatusByEnvironmentId: new Map() }) }
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: async () => ({}) }))

const automation = makeAutomation({
  id: 'a',
  createdAt: 10,
  once: { by: 5000 },
  enabled: true,
  on: [{ id: 'wh-wh_7Kx2pQ9mZbV4tL1r', source: 'webhook', event: 'call', rev: 1 }]
})
const present: AutomationReceiptRead = {
  status: 'ready',
  automation,
  owner: { selector: { kind: 'self' } }
}
const deferred = <T>() => Promise.withResolvers<T>()

function rig() {
  let read: () => Promise<AutomationReceiptRead> = async () => present
  let runs: () => Promise<AutomationRun[]> = async () => []
  let remove: () => Promise<boolean> = async () => true
  let current = true
  const controller = new AutomationCardDetailsController({
    current: () => current,
    read: () => read(),
    runs: () => runs(),
    remove: () => remove(),
    update: async (_automation, _owner, enabled) => ({ ...automation, enabled }),
    run: async () => {}
  })
  return {
    controller,
    read: (next: typeof read) => {
      read = next
    },
    runs: (next: typeof runs) => {
      runs = next
    },
    remove: (next: typeof remove) => {
      remove = next
    },
    retire: () => {
      current = false
      controller.invalidate()
    }
  }
}

function settled(controller: AutomationCardDetailsController, status: string): Promise<void> {
  if (controller.getSnapshot().status === status) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const unsubscribe = controller.subscribe(() => {
      if (controller.getSnapshot().status === status) {
        unsubscribe()
        resolve()
      }
    })
  })
}

it('keeps a successful definition when only history reports not-found', async () => {
  const { controller, runs } = rig()
  runs(async () => {
    throw new Error('Automation not found.')
  })
  await controller.reload()
  expect(controller.getSnapshot()).toMatchObject({
    status: 'ready',
    automation: { id: 'a' },
    runs: null
  })
})

it('accepts only the latest definition read within the same mutation generation', async () => {
  const { controller, read } = rig()
  const old = deferred<AutomationReceiptRead>()
  const latest = deferred<AutomationReceiptRead>()
  read(() => old.promise)
  const r0 = controller.reload()
  read(() => latest.promise)
  const r1 = controller.reload()
  latest.resolve({ ...present, automation: { ...automation, enabled: false } })
  await r1
  old.resolve(present)
  await r0
  expect(controller.getSnapshot()).toMatchObject({
    status: 'ready',
    automation: { enabled: false }
  })
})

it('fences a pre-Cancel reply and preserves the acknowledgement across a post-ack missing read', async () => {
  const { controller, read } = rig()
  await controller.reload()
  const old = deferred<AutomationReceiptRead>()
  const reconcile = deferred<AutomationReceiptRead>()
  read(() => old.promise)
  const r0 = controller.reload()
  read(() => reconcile.promise)
  await controller.remove()
  old.resolve(present)
  await r0
  expect(controller.getSnapshot()).toEqual({ status: 'loading', acknowledgement: 'deleted' })
  const missing = settled(controller, 'missing')
  reconcile.resolve({ status: 'missing' })
  await missing
  expect(controller.getSnapshot()).toEqual({ status: 'missing', acknowledgement: 'deleted' })
})

it('does not revive a deleted definition from late history when reconciliation fails', async () => {
  const { controller, read, runs } = rig()
  read(async () => ({ ...present, automation: { ...automation, once: undefined } }))
  await controller.reload()
  const oldRuns = deferred<AutomationRun[]>()
  runs(() => oldRuns.promise)
  const r0 = controller.reload()
  // Wait for the public transport boundary, without clock-based ordering.
  await Promise.resolve()
  read(async () => {
    throw new Error('Disconnected')
  })
  await controller.remove()
  await settled(controller, 'error')
  oldRuns.resolve([])
  await r0
  expect(controller.getSnapshot()).toEqual({ status: 'error', acknowledgement: 'deleted' })
})

it('rejects an in-flight acknowledgement after its owner binding is retired', async () => {
  const { controller, remove, retire } = rig()
  await controller.reload()
  const ack = deferred<boolean>()
  remove(() => ack.promise)
  const cancel = controller.remove()
  retire()
  ack.resolve(true)
  await cancel
  expect(controller.getSnapshot()).toEqual({ status: 'unverified' })
})

it('does not acknowledge removal when the host reports that no definition was removed', async () => {
  const { controller, remove } = rig()
  await controller.reload()
  remove(async () => false)
  await expect(controller.remove()).rejects.toThrow()
  expect(controller.getSnapshot()).not.toHaveProperty('acknowledgement')
})

it.each([false, true])(
  'acknowledges only definition removal with an already admitted run: %s',
  async (admitted) => {
    const { controller, read, runs } = rig()
    runs(async () => (admitted ? [makeRun({ automationId: 'a', status: 'dispatched' })] : []))
    await controller.reload()
    read(async () => ({ status: 'missing' }))
    await controller.remove()
    await settled(controller, 'missing')
    expect(controller.getSnapshot()).toEqual({ status: 'missing', acknowledgement: 'deleted' })
  }
)

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

it.each([
  ['update', 'while hidden'],
  ['remove', 'while hidden'],
  ['update', 'after reconnect'],
  ['remove', 'after reconnect']
] as const)(
  'gives a retained pane one fresh post-ack read when its %s is acknowledged %s',
  async (mutation, when) => {
    let reads = 0
    let effects = 0
    let read: () => Promise<AutomationReceiptRead> = async () => present
    const updated = deferred<typeof automation>()
    const removed = deferred<boolean>()
    const controller = new AutomationCardDetailsController({
      current: () => true,
      read: () => {
        reads++
        return read()
      },
      runs: async () => [],
      update: () => {
        effects++
        return updated.promise
      },
      remove: () => {
        effects++
        return removed.promise
      },
      run: async () => {}
    })
    const acknowledge = () =>
      mutation === 'update'
        ? updated.resolve({ ...automation, enabled: false })
        : removed.resolve(true)
    const fresh: AutomationReceiptRead =
      mutation === 'update'
        ? { ...present, automation: { ...automation, enabled: false } }
        : { status: 'missing' }
    controller.start()
    await settled(controller, 'ready')
    const mutating = mutation === 'update' ? controller.setEnabled(false) : controller.remove()
    // The chat pane's <Activity> hides: effects clean up, the controller is retained.
    controller.dispose()
    if (when === 'while hidden') {
      acknowledge()
      await mutating
      read = async () => fresh
      const before = reads
      controller.start()
      await flush()
      expect(reads - before).toBe(1)
    } else {
      const resumed = deferred<AutomationReceiptRead>()
      read = () => resumed.promise
      controller.start()
      const reconcile = deferred<AutomationReceiptRead>()
      read = () => reconcile.promise
      const before = reads
      acknowledge()
      await mutating
      expect(reads - before).toBe(1)
      // The read resumed before the acknowledgement reports the old definition; it is obsolete.
      resumed.resolve(present)
      await flush()
      expect(controller.getSnapshot().status).toBe('loading')
      reconcile.resolve(fresh)
      await flush()
    }
    expect(effects).toBe(1)
    expect(controller.getSnapshot()).toEqual(
      mutation === 'update'
        ? { ...fresh, runs: [] }
        : { status: 'missing', acknowledgement: 'deleted' }
    )
  }
)

/** A retained pane's controller with held writes, counted reads and a host watch it can trip. */
function heldRig() {
  let reads = 0
  let read: () => Promise<AutomationReceiptRead> = async () => present
  const revokers = new Set<() => void>()
  const updated = deferred<typeof automation>()
  const controller = new AutomationCardDetailsController({
    current: () => true,
    watch: (revoke) => {
      revokers.add(revoke)
      return () => revokers.delete(revoke)
    },
    read: () => {
      reads++
      return read()
    },
    runs: async () => [],
    update: () => updated.promise,
    remove: async () => true,
    run: async () => {}
  })
  return {
    controller,
    revokers,
    updated,
    reads: () => reads,
    read: (next: typeof read) => {
      read = next
    }
  }
}

it.each(['acknowledged', 'rejected'] as const)(
  'voids a hidden pane’s write when its host is refused and recovers while hidden (%s), with no toast',
  async (outcome) => {
    const { controller, revokers, updated, reads } = heldRig()
    controller.start()
    await settled(controller, 'ready')
    const writing = controller.setEnabled(false)
    controller.dispose()
    // The pane is hidden; the host is refused, then looks the same again before it returns.
    expect(revokers.size).toBe(1)
    revokers.forEach((revoke) => revoke())
    if (outcome === 'acknowledged') {
      updated.resolve({ ...automation, enabled: false })
    } else {
      updated.reject(new Error('The chat’s host changed.'))
    }
    // The old caller settles quietly: nothing for its toast.
    await expect(writing).resolves.toBeUndefined()
    const before = reads()
    controller.start()
    await flush()
    expect(reads()).toBe(before)
    expect(controller.getSnapshot()).toEqual({ status: 'unverified' })
  }
)

it('keeps the host watch only while a hidden write is in flight, and drops it on true unmount', async () => {
  const { controller, revokers, updated, reads } = heldRig()
  controller.start()
  await settled(controller, 'ready')
  controller.dispose()
  expect(revokers.size).toBe(0)
  controller.start()
  await settled(controller, 'ready')
  const writing = controller.setEnabled(false)
  // Unmounted for good while the write is in flight.
  controller.dispose()
  expect(revokers.size).toBe(1)
  const before = reads()
  updated.resolve({ ...automation, enabled: false })
  await writing
  await flush()
  expect(revokers.size).toBe(0)
  expect(reads()).toBe(before)
})

it('reads on open and once after its own Pause, and never in the background while open', async () => {
  const { controller, updated, reads } = heldRig()
  controller.start()
  await settled(controller, 'ready')
  expect(reads()).toBe(1)
  const writing = controller.setEnabled(false)
  updated.resolve({ ...automation, enabled: false })
  await writing
  await flush()
  expect(reads()).toBe(2)
  // Nothing else re-reads: a change made elsewhere shows the next time the card opens.
  await new Promise<void>((resolve) => setTimeout(resolve, 20))
  expect(reads()).toBe(2)
})

it('re-reads current settings when the card is opened again', async () => {
  const first = heldRig()
  first.controller.start()
  await settled(first.controller, 'ready')
  first.controller.dispose()
  // Closing unmounts Details; opening again makes a new controller, which reads what is current now.
  const reopened = heldRig()
  const paused = { ...present, automation: { ...automation, enabled: false } }
  reopened.read(async () => paused)
  reopened.controller.start()
  await settled(reopened.controller, 'ready')
  expect(reopened.reads()).toBe(1)
  expect(reopened.controller.getSnapshot()).toEqual({ ...paused, runs: [] })
})
