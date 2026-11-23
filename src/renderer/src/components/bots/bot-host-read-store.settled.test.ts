import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as BotHosts from '@/lib/bot-hosts'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { BotReadMoreFailed } from '../../../../shared/bots/bot-read-more-failed'
import { createBotHostRead } from './bot-host-read-store'
import type { BotReadAuthority } from './bot-read-authority'

// Only the transport is stubbed: each call waits on a deferred the test settles.
type Call = {
  method: string
  options: unknown
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
}
const calls: Call[] = []
type BotHostsModule = typeof BotHosts
vi.mock('@/lib/bot-hosts', async (importOriginal) => ({
  ...(await importOriginal<BotHostsModule>()),
  callBotRpc: (_bot: unknown, method: string, _params: unknown, options: unknown) =>
    new Promise((resolve, reject) => calls.push({ method, options, resolve, reject }))
}))

type Value = { n: number; authority: BotReadAuthority }
const bot = { hostId: 'local' as const, id: 'b1' }
const KEY = 'local\u0000b1'
let clock = 0

function makeRead() {
  return createBotHostRead<Value>(
    'test.read',
    (result: { n: number }, authority) => ({ n: result.n, authority }),
    'read failed',
    ['automations']
  )
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve()
  }
}

beforeEach(() => {
  calls.length = 0
  clock = 0
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const advance = (ms: number): void => {
  clock += ms
  vi.advanceTimersByTime(ms)
}

describe('requestSettled', () => {
  it('is not decided by a read already running, only by the one after it', async () => {
    const read = makeRead()
    read.subscribe(bot, () => {})
    read.request(bot)
    await flush()
    expect(calls).toHaveLength(1)
    let settled: unknown = null
    void read.requestSettled(bot).then((s) => (settled = s))
    calls[0].resolve({ n: 1 })
    await flush()
    // The earlier read publishes, but cannot settle an ask made while it ran.
    expect(read.snapshot(KEY)?.n).toBe(1)
    expect(settled).toBeNull()
    expect(calls).toHaveLength(2)
    calls[1].resolve({ n: 2 })
    await flush()
    expect(settled).toEqual({ ok: true, value: { n: 2, authority: { kind: 'local' } } })
  })

  it('settles uncertain when the qualifying read fails, and a later read recovers', async () => {
    const read = makeRead()
    read.subscribe(bot, () => {})
    const settled = read.requestSettled(bot)
    await flush()
    calls[0].reject(new Error('down'))
    await flush()
    await expect(settled).resolves.toEqual({ ok: false })
    read.request(bot)
    await flush()
    calls[1].resolve({ n: 3 })
    await flush()
    expect(read.state(KEY)).toBe('ready')
  })

  it('settles an unchanged answer that tells no listener', async () => {
    const read = makeRead()
    const listener = vi.fn()
    read.subscribe(bot, listener)
    read.request(bot)
    await flush()
    calls[0].resolve({ n: 1 })
    await flush()
    listener.mockClear()
    const settled = read.requestSettled(bot)
    await flush()
    calls[1].resolve({ n: 1 })
    await flush()
    expect(listener).not.toHaveBeenCalled()
    await expect(settled).resolves.toMatchObject({ ok: true, value: { n: 1 } })
  })

  it('ends uncertain at its own deadline behind a read that never returns', async () => {
    const read = makeRead()
    read.subscribe(bot, () => {})
    read.request(bot)
    await flush()
    let settled: unknown = null
    void read.requestSettled(bot).then((s) => (settled = s))
    advance(14_999)
    await flush()
    expect(settled).toBeNull()
    advance(1)
    await flush()
    expect(settled).toEqual({ ok: false })
    // The predecessor and the trailing read landing later change nothing.
    calls[0].resolve({ n: 1 })
    await flush()
    calls[1].resolve({ n: 2 })
    await flush()
    expect(settled).toEqual({ ok: false })
    expect(read.snapshot(KEY)?.n).toBe(2)
  })

  it('treats an answer at its deadline as uncertain even before the timer runs', async () => {
    const read = makeRead()
    read.subscribe(bot, () => {})
    const settled = read.requestSettled(bot)
    await flush()
    clock += 15_000 // the clock passes the deadline while the timer callback is held
    calls[0].resolve({ n: 1 })
    await flush()
    await expect(settled).resolves.toEqual({ ok: false })
  })

  it('gives each ask its own deadline', async () => {
    const read = makeRead()
    read.subscribe(bot, () => {})
    let first: unknown = null
    let second: unknown = null
    void read.requestSettled(bot).then((s) => (first = s))
    advance(10_000)
    void read.requestSettled(bot).then((s) => (second = s))
    await flush()
    expect(calls).toHaveLength(1)
    advance(5_000)
    await flush()
    expect(first).toEqual({ ok: false })
    expect(second).toBeNull()
    calls[0].resolve({ n: 4 })
    await flush()
    expect(second).toMatchObject({ ok: true, value: { n: 4 } })
  })

  it('ends uncertain when the last surface closes, and a new entry inherits nothing', async () => {
    const read = makeRead()
    const close = read.subscribe(bot, () => {})
    let settled: unknown = null
    void read.requestSettled(bot).then((s) => (settled = s))
    await flush()
    close()
    await flush()
    expect(settled).toEqual({ ok: false })
    read.subscribe(bot, () => {})
    let fresh: unknown = null
    void read.requestSettled(bot).then((s) => (fresh = s))
    await flush()
    // The old read's late answer belongs to the disposed entry.
    calls[0].resolve({ n: 9 })
    await flush()
    expect(fresh).toBeNull()
    calls[1].resolve({ n: 10 })
    await flush()
    expect(fresh).toMatchObject({ ok: true, value: { n: 10 } })
    advance(15_000)
    await flush()
    expect(fresh).toMatchObject({ ok: true })
  })

  it('is decided before listeners run, so one closing the last surface keeps the success', async () => {
    const read = makeRead()
    const close = read.subscribe(bot, () => close())
    const settled = read.requestSettled(bot)
    await flush()
    calls[0].resolve({ n: 5 })
    await flush()
    await expect(settled).resolves.toMatchObject({ ok: true, value: { n: 5 } })
  })

  it('needs an open surface and never waits in an entry no surface holds', async () => {
    const read = makeRead()
    await expect(read.requestSettled(bot)).resolves.toEqual({ ok: false })
    await flush()
    expect(calls).toHaveLength(0)
    // An entry a request made before any surface subscribed: no last unsubscribe would ever end a wait in it.
    read.request(bot)
    await flush()
    let settled: unknown = null
    void read.requestSettled(bot).then((s) => (settled = s))
    await flush()
    expect(settled).toEqual({ ok: false })
  })

  it('is uncertain when a read lands only part of its value', async () => {
    const read = createBotHostRead<{ n: number }>(
      'test.items',
      (result: never) => result,
      'read failed',
      ['items'],
      0,
      false,
      {
        partsOf: () => null,
        maxParts: 0,
        load: () => Promise.reject(new BotReadMoreFailed({ n: 7 }))
      }
    )
    read.subscribe(bot, () => {})
    const settled = read.requestSettled(bot)
    await flush()
    await expect(settled).resolves.toEqual({ ok: false })
    expect(read.snapshot(KEY)?.n).toBe(7)
  })
})

describe('read authority', () => {
  it('sends the revision it captured before the read, and records it', async () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env-a', createdAt: 1, pairingRevision: 11 }])
    const read = makeRead()
    const remote = { hostId: 'runtime:env-a' as const, id: 'b1' }
    read.subscribe(remote, () => {})
    read.request(remote)
    await flush()
    replaceRuntimeEnvironmentRevisions([{ id: 'env-a', createdAt: 1, pairingRevision: 22 }])
    expect(calls[0].options).toEqual({ expectedEnvironmentPairingRevision: 11 })
    calls[0].resolve({ n: 1 })
    await flush()
    expect(read.snapshot('runtime:env-a\u0000b1')?.authority).toEqual({
      kind: 'environment',
      environmentId: 'env-a',
      pairingRevision: 11
    })
  })

  it('records an unknown revision as unavailable and sends no fence', async () => {
    replaceRuntimeEnvironmentRevisions([])
    const read = makeRead()
    const remote = { hostId: 'runtime:env-b' as const, id: 'b1' }
    read.subscribe(remote, () => {})
    read.request(remote)
    await flush()
    expect(calls[0].options).toBeUndefined()
    calls[0].resolve({ n: 1 })
    await flush()
    expect(read.snapshot('runtime:env-b\u0000b1')?.authority).toEqual({
      kind: 'environment-unavailable',
      environmentId: 'env-b'
    })
  })
})
