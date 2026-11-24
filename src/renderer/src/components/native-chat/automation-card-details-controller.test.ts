import { afterEach, expect, it, vi } from 'vitest'
import { makeAutomation, makeRun } from '@/components/automations/automations-page-fixtures'
import type { AutomationReceiptRead } from '../../../../shared/automations/automation-receipt-read'
import type { AutomationRun } from '../../../../shared/automations/history/automation-run'
import type { WebhookKey } from '../../../../shared/rpc-contract/webhooks-params'
import { AutomationCardDetailsController } from './automation-card-details-controller'
import { deleteAutomationForTarget } from '@/components/automations/hosts/automation-host-client'
import { subscribeAutomationDefinitionAcknowledgements } from '@/components/automations/events/automation-definition-acknowledgements'

vi.mock('@/components/automations/hosts/automation-capability-probe', () => ({
  prepareAutomationLaunchSetup: () => {}
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ runtimeStatusByEnvironmentId: new Map() }) }
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: async () => ({}) }))
afterEach(() => vi.useRealTimers())

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
  let key: () => Promise<WebhookKey> = async () => ({
    key: 'secret',
    url: 'https://hooks.test/current'
  })
  const controller = new AutomationCardDetailsController({
    current: () => current,
    read: () => read(),
    runs: () => runs(),
    remove: () => remove(),
    update: async (_automation, _owner, enabled) => ({ ...automation, enabled }),
    run: async () => {},
    webhookKey: () => key()
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
    },
    key: (next: typeof key) => {
      key = next
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

it('copies only under the binding and mutation generation that requested the webhook key', async () => {
  const { controller, key, retire } = rig()
  await controller.reload()
  let clipboard = ''
  await controller.copyWebhookUrl((url) => {
    clipboard = url
  })
  expect(clipboard).toBe('https://hooks.test/current')
  const old = deferred<WebhookKey>()
  key(() => old.promise)
  const copying = controller.copyWebhookUrl((url) => {
    clipboard = url
  })
  retire()
  old.resolve({ key: 'old-secret', url: 'https://hooks.test/obsolete' })
  await copying
  expect(clipboard).toBe('https://hooks.test/current')
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

it('fences pre-ack reads through the shared delete caller, independent of a wall-clock rollback', async () => {
  const { controller, read } = rig()
  read(async () => ({ ...present, automation: { ...automation, enabled: false } }))
  await controller.reload()
  const old = deferred<AutomationReceiptRead>()
  const reconcile = deferred<AutomationReceiptRead>()
  read(() => old.promise)
  const r0 = controller.reload()
  read(() => reconcile.promise)
  const unsubscribe = subscribeAutomationDefinitionAcknowledgements(({ automationId }) => {
    if (automationId === 'a') {
      controller.changed()
    }
  })
  try {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    await deleteAutomationForTarget({ id: 'a', runContext: null }, { kind: 'local' })
    vi.setSystemTime(0)
    old.resolve(present)
    await r0
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      automation: { enabled: false }
    })
    const missing = settled(controller, 'missing')
    reconcile.resolve({ status: 'missing' })
    await missing
    expect(controller.getSnapshot()).toEqual({ status: 'missing' })
  } finally {
    unsubscribe()
    controller.dispose()
  }
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
  ['update', 'while hidden', 'none'],
  ['remove', 'while hidden', 'none'],
  ['update', 'after reconnect', 'none'],
  ['remove', 'after reconnect', 'none'],
  ['update', 'after reconnect', 'host notice first'],
  ['remove', 'after reconnect', 'host notice first']
] as const)(
  'gives a retained pane one fresh post-ack read when its %s is acknowledged %s (%s)',
  async (mutation, when, notice) => {
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
      if (notice === 'host notice first') {
        controller.hostChanged('definition')
      }
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

it.each(['while its reconcile read is in flight', 'after it settles'] as const)(
  'reads once for its own write when the host’s notice of it lands %s, and again for a later change',
  async (when) => {
    const { controller, updated, reads, read } = heldRig()
    controller.start()
    await settled(controller, 'ready')
    const writing = controller.setEnabled(false)
    const reconcile = deferred<AutomationReceiptRead>()
    read(() => reconcile.promise)
    updated.resolve({ ...automation, enabled: false })
    await writing
    expect(reads()).toBe(2)
    const paused = { ...present, automation: { ...automation, enabled: false } }
    if (when === 'after it settles') {
      reconcile.resolve(paused)
      await flush()
    }
    controller.hostChanged('definition')
    if (when === 'while its reconcile read is in flight') {
      reconcile.resolve(paused)
      await flush()
    }
    // The echo neither reads again nor displaces the reconcile's observation.
    expect(reads()).toBe(2)
    expect(controller.getSnapshot()).toEqual({ ...paused, runs: [] })
    read(async () => present)
    controller.hostChanged('definition')
    await flush()
    expect(reads()).toBe(3)
    expect(controller.getSnapshot()).toEqual({ ...present, runs: [] })
  }
)

it.each([
  ['a run notice', 'run', 0],
  ['a definition notice past the window', 'definition', 5_001]
] as const)('still reads for %s after its own write', async (_case, reason, later) => {
  const { controller, updated, reads } = heldRig()
  controller.start()
  await settled(controller, 'ready')
  const writing = controller.setEnabled(false)
  updated.resolve({ ...automation, enabled: false })
  await writing
  await flush()
  const now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(now + later)
  controller.hostChanged(reason)
  await flush()
  vi.restoreAllMocks()
  expect(reads()).toBe(3)
})

it('takes a notice that lands before its own reply as the echo, so the next one reads', async () => {
  const { controller, updated, reads } = heldRig()
  controller.start()
  await settled(controller, 'ready')
  const writing = controller.setEnabled(false)
  controller.hostChanged('definition')
  updated.resolve({ ...automation, enabled: false })
  await writing
  await flush()
  expect(reads()).toBe(2)
  controller.hostChanged('definition')
  await flush()
  expect(reads()).toBe(3)
})
