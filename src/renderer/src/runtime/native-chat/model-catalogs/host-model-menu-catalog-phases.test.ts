const transport = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('../requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: transport.call
}))
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionModelCatalogResult } from '../../../../../shared/agent-session/agent-session-wire'
import { hostModelMenuCatalog } from './host-model-menu-catalog'
import { resetHostModelCatalogSnapshotsForTests } from './host-model-catalog-snapshots'

const target = { kind: 'local' } as const
const listing = { origin: 'unknown', listingInProgress: true } as const
const expired = { ...listing, waitExpired: true } as const
const models = (id: string): AgentSessionModelCatalogResult => ({
  origin: 'probe',
  fetchedAt: 1,
  listingNamesConfiguredModel: false,
  models: [{ id, label: id, isDefault: false, efforts: [] }]
})
function transportReply() {
  const result = Promise.withResolvers<AgentSessionModelCatalogResult>()
  const started = Promise.withResolvers<void>()
  return {
    ...result,
    started: started.promise,
    request: () => {
      started.resolve()
      return result.promise
    }
  }
}
beforeEach(() => {
  resetHostModelCatalogSnapshotsForTests()
  transport.call.mockReset()
})

it('withdraws abandoned queued upgrades and shares the surviving upgrade across reopen without listeners', async () => {
  const first = transportReply(),
    reopened = transportReply(),
    wait = transportReply()
  let reopening = false
  const request = vi.fn<(waited: boolean) => Promise<AgentSessionModelCatalogResult>>((waited) =>
    reopening
      ? waited
        ? wait.request()
        : reopened.request()
      : waited
        ? Promise.resolve(models('unwanted-orphan'))
        : first.request()
  )
  transport.call.mockImplementation((_target, _method, params) =>
    request(params.waitForListing === true)
  )
  const scope = { target, agent: 'codex', worktree: 'id:queued-lifetime' }
  const owner = hostModelMenuCatalog(scope)
  const a = new AbortController(),
    b = new AbortController()
  const nextA = new AbortController(),
    nextB = new AbortController()
  const reads: Promise<AgentSessionModelCatalogResult | undefined>[] = []
  const stops: (() => void)[] = []
  const display = vi.fn()
  stops.push(owner.subscribe(display))
  try {
    const plain = owner.read(false, a.signal)
    reads.push(plain)
    await first.started
    const queued = owner.read(true, b.signal)
    reads.push(queued)
    expect(request.mock.calls).toEqual([[false]])
    // The mounted display subscription owns no permission to continue either ended request.
    a.abort()
    b.abort()
    first.resolve(listing)
    const ended = await Promise.all([plain, queued])
    expect(request.mock.calls).toEqual([[false]])
    expect(ended.every((answer) => !answer?.waitExpired)).toBe(true)
    stops[0]()

    reopening = true
    const successor = hostModelMenuCatalog(scope)
    stops.push(successor.subscribe(display))
    const plainA = successor.read(false, nextA.signal)
    const plainB = successor.read(false, nextB.signal)
    reads.push(plainA, plainB)
    await reopened.started
    expect(request.mock.calls).toEqual([[false], [false]])
    const waitA = successor.read(true, nextA.signal)
    const waitB = successor.read(true, nextB.signal)
    reads.push(waitA, waitB)
    nextA.abort()
    stops[1]()
    reopened.resolve(listing)
    await Promise.all([plainA, plainB])
    await wait.started
    expect(request.mock.calls).toEqual([[false], [false], [true]])
    // The remaining request signal alone retains the registered owner and physical wait.
    expect(hostModelMenuCatalog(scope)).toBe(successor)
    expect(await successor.read(false, nextB.signal)).toEqual(listing)
    expect(request.mock.calls).toEqual([[false], [false], [true]])
    stops.push(successor.subscribe(display))
    wait.resolve(models('fresh-after-reopen'))
    expect(await waitB).toMatchObject({ models: [{ id: 'fresh-after-reopen' }] })
    expect(await waitA).toBeUndefined()
    expect(successor.snapshot.answer).toMatchObject({ models: [{ id: 'fresh-after-reopen' }] })
    expect(display).toHaveBeenCalled()
  } finally {
    a.abort()
    b.abort()
    nextA.abort()
    nextB.abort()
    stops.forEach((stop) => stop())
    first.resolve(listing)
    reopened.resolve(listing)
    wait.resolve(models('cleanup'))
    await Promise.allSettled(reads)
  }
})

it('shares actual waits, stops after failure, follows open Settings to completion and never renews closed demand', async () => {
  const plain = transportReply(),
    firstWait = transportReply(),
    failure = transportReply()
  const reopenPlain = transportReply(),
    reopenWait = transportReply(),
    finalWait = transportReply()
  const closingPlain = transportReply(),
    closingWait = transportReply()
  const ports = [
    plain,
    firstWait,
    failure,
    reopenPlain,
    reopenWait,
    finalWait,
    closingPlain,
    closingWait
  ]
  const request = vi.fn<(waited: boolean) => Promise<AgentSessionModelCatalogResult>>()
  for (const port of ports) {
    request.mockImplementationOnce(port.request)
  }
  transport.call.mockImplementation((_target, _method, params) =>
    request(params.waitForListing === true)
  )
  const scope = { target, agent: 'codex', worktree: 'id:phase-outcomes' }
  const owner = hostModelMenuCatalog(scope)
  const settings = new AbortController(),
    picker = new AbortController()
  const reopened = new AbortController(),
    explicit = new AbortController()
  const closing = new AbortController(),
    survivor = new AbortController()
  const signals = [settings, picker, reopened, explicit, closing, survivor]
  const reads: Promise<AgentSessionModelCatalogResult | undefined>[] = []
  const stop = owner.subscribe(() => {})
  try {
    const automatic = owner.read(undefined, settings.signal)
    const pickerPlain = owner.read(false, picker.signal)
    const pickerWait = owner.read(true, picker.signal)
    reads.push(automatic, pickerPlain, pickerWait)
    await plain.started
    plain.resolve(listing)
    expect(await pickerPlain).toEqual(listing)
    await firstWait.started
    const provisional = owner.read(false, picker.signal)
    reads.push(provisional)
    firstWait.resolve({ ...models('gpt-6.1-sol'), listingInProgress: true, waitExpired: true })
    expect(await provisional).toEqual(listing)
    expect(await pickerWait).toMatchObject({ models: [{ id: 'gpt-6.1-sol' }], waitExpired: true })
    await failure.started
    const failedPicker = owner.read(true, picker.signal)
    reads.push(failedPicker)
    failure.reject(new Error('host offline'))
    for (const answer of await Promise.all([automatic, failedPicker])) {
      expect(answer).toMatchObject({ models: [{ id: 'gpt-6.1-sol' }] })
      expect(answer?.waitExpired).toBeUndefined()
    }
    expect(request.mock.calls).toEqual([[false], [true], [true]])
    expect(owner.snapshot.pending).toBe(false)
    settings.abort()
    picker.abort()

    const follow = owner.read(undefined, reopened.signal)
    const sharedWait = owner.read(true, explicit.signal)
    reads.push(follow, sharedWait)
    await reopenPlain.started
    reopenPlain.resolve(listing)
    await reopenWait.started
    reopenWait.resolve(expired)
    expect(await sharedWait).toMatchObject({ listingInProgress: true, waitExpired: true })
    await finalWait.started
    finalWait.resolve(models('finally-listed'))
    expect(await follow).toMatchObject({ models: [{ id: 'finally-listed' }] })
    expect(owner.snapshot.answer).toMatchObject({ models: [{ id: 'finally-listed' }] })
    expect(request.mock.calls).toEqual([[false], [true], [true], [false], [true], [true]])
    reopened.abort()
    explicit.abort()

    const ended = owner.read(undefined, closing.signal)
    reads.push(ended)
    await closingPlain.started
    closingPlain.resolve(listing)
    await closingWait.started
    closing.abort()
    stop()
    expect(hostModelMenuCatalog(scope)).toBe(owner)
    const stillShared = hostModelMenuCatalog(scope).read(true, survivor.signal)
    reads.push(stillShared)
    closingWait.resolve(expired)
    await Promise.all([ended, stillShared])
    expect(request.mock.calls).toEqual([
      [false],
      [true],
      [true],
      [false],
      [true],
      [true],
      [false],
      [true]
    ])
  } finally {
    signals.forEach((signal) => signal.abort())
    stop()
    ports.forEach((port) => port.resolve({ origin: 'unknown' }))
    await Promise.allSettled(reads)
  }
})
