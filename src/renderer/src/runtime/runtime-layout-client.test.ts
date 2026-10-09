import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'
import type { PublishedWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-published'
import {
  applyLayoutFrame,
  EMPTY_WORKSPACE_LAYOUT_CACHE,
  type WorkspaceLayoutCache
} from '../store/workspace-layout-cache'
import { createRuntimeLayoutClient, runtimeLayoutTransport } from './runtime-layout-client'
import type { RuntimeClientTarget } from './runtime-client-target'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'

type FakeStream = {
  method: string
  params: unknown
  unsubscribed: boolean
  send: (result: unknown) => void
  fail: (message: string, code?: string) => void
  /** The stream is gone: the local runtime ends it with a frame, a remote transport closes. */
  drop: () => void
}

type FakeHost = {
  streams: FakeStream[]
  calls: { method: string; params: unknown }[]
  rejectNextSubscribe: () => void
}

const meta = { runtimeId: 'runtime-1' }

/** One fake per transport, behind the real window.api surface each one uses. */
function installFakeHost(target: RuntimeClientTarget): FakeHost {
  const host: FakeHost = { streams: [], calls: [], rejectNextSubscribe: () => {} }
  let rejectNext = false
  host.rejectNextSubscribe = () => {
    rejectNext = true
  }
  const open = (
    method: string,
    params: unknown,
    onResponse: (response: unknown) => void,
    onClose: () => void
  ): { unsubscribe: () => void; sendBinary: () => void } => {
    if (rejectNext) {
      rejectNext = false
      throw new Error('host unreachable')
    }
    const stream: FakeStream = {
      method,
      params,
      unsubscribed: false,
      send: (result) => onResponse({ id: 's', ok: true, result, _meta: meta }),
      fail: (message, code = 'internal_error') =>
        onResponse({ id: 's', ok: false, error: { code, message }, _meta: meta }),
      drop: target.kind === 'local' ? () => stream.send({ type: 'end' }) : onClose
    }
    host.streams.push(stream)
    return {
      unsubscribe: () => {
        stream.unsubscribed = true
      },
      sendBinary: () => {}
    }
  }
  const answer = (method: string, params: unknown) => {
    host.calls.push({ method, params })
    const result =
      method === 'status.get'
        ? {
            runtimeId: 'runtime-1',
            graphStatus: 'ready',
            runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
          }
        : { applied: true }
    return Promise.resolve({ id: method, ok: true, result, _meta: meta })
  }
  vi.stubGlobal('window', {
    api: {
      runtime: {
        call: vi.fn((args: { method: string; params?: unknown }) =>
          target.kind === 'local' ? answer(args.method, args.params) : Promise.reject()
        ),
        subscribe: vi.fn(
          async (
            args: { method: string; params?: unknown },
            callback: (response: unknown) => void
          ) => open(args.method, args.params, callback, () => {})
        )
      },
      runtimeEnvironments: {
        call: vi.fn((args: { selector: string; method: string; params?: unknown }) =>
          args.selector === 'env-1' ? answer(args.method, args.params) : Promise.reject()
        ),
        subscribe: vi.fn(
          async (
            args: { selector: string; method: string; params?: unknown },
            callbacks: { onResponse: (response: unknown) => void; onClose?: () => void }
          ) => {
            expect(args.selector).toBe('env-1')
            return open(args.method, args.params, callbacks.onResponse, () => callbacks.onClose?.())
          }
        )
      }
    }
  })
  return host
}

function layout(worktreeId: string, tabIds: string[] = []): PublishedWorkspaceLayout {
  return {
    worktreeId,
    groups: [{ id: `group-${worktreeId}`, tabIds }],
    tabs: [],
    editorFiles: [],
    browserTabs: []
  }
}

const targets: [string, RuntimeClientTarget][] = [
  ['local runtime', { kind: 'local' }],
  ['remote server', { kind: 'environment', environmentId: 'env-1' }]
]

describe.each(targets)('runtime layout client over the %s transport', (_name, target) => {
  let host: FakeHost
  let cache: WorkspaceLayoutCache
  let statuses: string[]

  beforeEach(() => {
    vi.useFakeTimers()
    clearRuntimeCompatibilityCacheForTests()
    host = installFakeHost(target)
    cache = EMPTY_WORKSPACE_LAYOUT_CACHE
    statuses = []
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function subscribe(workspaces?: 'all' | string[]) {
    return createRuntimeLayoutClient(runtimeLayoutTransport(target)).subscribe(
      { workspaces },
      (frame) => {
        cache = applyLayoutFrame(cache, frame)
      },
      (status) => statuses.push(status.state)
    )
  }

  async function opened(count: number): Promise<FakeStream> {
    await vi.waitFor(() => expect(host.streams).toHaveLength(count))
    // Lets the client receive the handle the transport resolved with.
    await vi.advanceTimersByTimeAsync(0)
    return host.streams[count - 1]!
  }

  it('fills the cache from the snapshot, then replaces or drops one workspace per event', async () => {
    subscribe(['a', 'b'])
    const stream = await opened(1)
    expect(stream).toMatchObject({ method: 'layout.subscribe', params: { workspaces: ['a', 'b'] } })
    stream.send({
      type: 'snapshot',
      subscriptionId: 'layout-1',
      workspaces: [
        { key: 'a', layout: layout('a') },
        { key: 'b', layout: layout('b') }
      ]
    })
    expect(cache).toEqual({ a: layout('a'), b: layout('b') })
    stream.send({ type: 'workspace', key: 'a', layout: layout('a', ['t1']) })
    stream.send({ type: 'removed', key: 'b' })
    expect(cache).toEqual({ a: layout('a', ['t1']) })
  })

  it('ignores a change before the snapshot, unknown frame types and malformed frames', async () => {
    subscribe()
    const stream = await opened(1)
    stream.send({ type: 'workspace', key: 'a', layout: layout('a') })
    stream.send({ type: 'snapshot', subscriptionId: 'layout-1', workspaces: [] })
    stream.send({ type: 'navigate', request: { focusTab: 't1' } })
    stream.send({ type: 'workspace', key: 'a', layout: { worktreeId: 'a' } })
    expect(cache).toEqual({})
  })

  it('after a lost stream, resubscribes and the new snapshot replaces the cache', async () => {
    subscribe()
    const first = await opened(1)
    first.send({
      type: 'snapshot',
      subscriptionId: 'layout-1',
      workspaces: [
        { key: 'a', layout: layout('a', ['t1', 't2']) },
        { key: 'b', layout: layout('b') }
      ]
    })
    first.drop()
    expect(first.unsubscribed).toBe(true)
    // The last state stays until the runtime sends a new one; nothing is cleared or guessed.
    expect(cache).toEqual({ a: layout('a', ['t1', 't2']), b: layout('b') })
    await vi.advanceTimersByTimeAsync(250)
    const second = await opened(2)
    // A late frame from the dropped stream changes nothing.
    first.send({ type: 'removed', key: 'a' })
    expect(cache).toHaveProperty('a')
    second.send({
      type: 'snapshot',
      subscriptionId: 'layout-2',
      workspaces: [{ key: 'a', layout: layout('a', ['t2']) }]
    })
    expect(cache).toEqual({ a: layout('a', ['t2']) })
  })

  it('a reconnect snapshot with unchanged data keeps every cached entry', async () => {
    subscribe()
    const first = await opened(1)
    const workspaces = [
      { key: 'a', layout: layout('a', ['t1']) },
      { key: 'b', layout: layout('b') }
    ]
    first.send({ type: 'snapshot', subscriptionId: 'layout-1', workspaces })
    const before = cache
    first.drop()
    await vi.advanceTimersByTimeAsync(250)
    const second = await opened(2)
    second.send(JSON.parse(JSON.stringify({ type: 'snapshot', workspaces })))
    expect(cache).toBe(before)
    expect(cache.a).toBe(before.a)
    expect(cache.b).toBe(before.b)
  })

  it('treats an error frame or a failed subscribe as a lost stream, with growing delays', async () => {
    host.rejectNextSubscribe()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    subscribe()
    await vi.advanceTimersByTimeAsync(0)
    expect(host.streams).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(250)
    const first = await opened(1)
    first.fail('stream failed')
    expect(first.unsubscribed).toBe(true)
    await vi.advanceTimersByTimeAsync(499)
    expect(host.streams).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    const second = await opened(2)
    second.send({ type: 'snapshot', subscriptionId: 'layout-2', workspaces: [] })
    second.drop()
    // A snapshot proves the host is back, so the next loss starts from the first delay again.
    await vi.advanceTimersByTimeAsync(250)
    await opened(3)
    expect(statuses).toEqual(['retrying', 'retrying', 'live', 'retrying'])
  })

  it.each(['method_not_found', 'forbidden'])(
    'stops for good when the host refuses the stream (%s)',
    async (code) => {
      const subscription = subscribe()
      const stream = await opened(1)
      stream.fail('no layout stream here', code)
      expect(stream.unsubscribed).toBe(true)
      expect(subscription.status()).toEqual({
        state: 'refused',
        code,
        message: 'no layout stream here'
      })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(host.streams).toHaveLength(1)
      subscription.close()
      expect(subscription.status().state).toBe('refused')
    }
  )

  it('close unsubscribes, stops retrying and ignores later frames', async () => {
    const subscription = subscribe()
    const stream = await opened(1)
    stream.send({ type: 'snapshot', subscriptionId: 'layout-1', workspaces: [] })
    subscription.close()
    expect(stream.unsubscribed).toBe(true)
    stream.send({ type: 'workspace', key: 'a', layout: layout('a') })
    stream.drop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(host.streams).toHaveLength(1)
    expect(cache).toEqual({})
  })

  it('close before the subscribe settles releases the stream it then gets', async () => {
    const subscription = subscribe()
    subscription.close()
    const stream = await opened(1)
    await vi.waitFor(() => expect(stream.unsubscribed).toBe(true))
  })

  it('sends commands as the same runtime method over the transport', async () => {
    const client = createRuntimeLayoutClient(runtimeLayoutTransport(target))
    await expect(client.command('layout.renameTab', { tabId: 't1', title: 'x' })).resolves.toEqual({
      applied: true
    })
    expect(host.calls.at(-1)).toEqual({
      method: 'layout.renameTab',
      params: { tabId: 't1', title: 'x' }
    })
  })
})
