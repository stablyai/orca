import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublishedWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-published'
import {
  applyLayoutFrame,
  EMPTY_WORKSPACE_LAYOUT_CACHE,
  type WorkspaceLayoutCache
} from '../store/workspace-layout-cache'
import type { RuntimeClientTarget } from './runtime-client-target'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import { subscribeRuntimeLayout, type RuntimeLayoutStreamStatus } from './runtime-layout-client'

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
  rejectNextSubscribe: (error?: Error) => void
}

const meta = { runtimeId: 'runtime-1' }

/** One fake per transport, behind the real window.api surface each one uses. */
function installFakeHost(target: RuntimeClientTarget): FakeHost {
  let rejectNext: Error | null = null
  const host: FakeHost = {
    streams: [],
    rejectNextSubscribe: (error = new Error('host unreachable')) => {
      rejectNext = error
    }
  }
  const open = (
    method: string,
    params: unknown,
    onResponse: (response: unknown) => void,
    onClose: () => void
  ): { unsubscribe: () => void; sendBinary: () => void } => {
    if (rejectNext) {
      const error = rejectNext
      rejectNext = null
      throw error
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
  vi.stubGlobal('window', {
    api: {
      runtime: {
        subscribe: vi.fn(
          async (
            args: { method: string; params?: unknown },
            callback: (response: unknown) => void
          ) => open(args.method, args.params, callback, () => {})
        )
      },
      runtimeEnvironments: {
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
  let status: RuntimeLayoutStreamStatus | null

  beforeEach(() => {
    vi.useFakeTimers()
    // No jitter unless a test asks for it, so delays read as the backoff ladder.
    vi.spyOn(Math, 'random').mockReturnValue(0)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1 }])
    host = installFakeHost(target)
    cache = EMPTY_WORKSPACE_LAYOUT_CACHE
    status = null
  })

  afterEach(() => {
    replaceRuntimeEnvironmentRevisions([])
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function subscribe(workspaces?: 'all' | string[]) {
    return subscribeRuntimeLayout(
      target,
      { workspaces },
      (frame) => {
        cache = applyLayoutFrame(cache, frame)
      },
      (next) => {
        status = next
      }
    )
  }

  async function opened(count: number): Promise<FakeStream> {
    await vi.waitFor(() => expect(host.streams).toHaveLength(count))
    // Lets the client receive the handle the transport resolved with.
    await vi.advanceTimersByTimeAsync(0)
    return host.streams[count - 1]!
  }

  /** Whether a retry opens exactly `delayMs` after the previous loss. */
  async function expectRetryAfter(delayMs: number): Promise<FakeStream> {
    const count = host.streams.length
    await vi.advanceTimersByTimeAsync(delayMs - 1)
    expect(host.streams).toHaveLength(count)
    await vi.advanceTimersByTimeAsync(1)
    return opened(count + 1)
  }

  function snapshot(workspaces: { key: string; layout: PublishedWorkspaceLayout }[] = []) {
    return { type: 'snapshot', subscriptionId: 'layout-1', workspaces }
  }

  it('fills the cache from the snapshot, then replaces or drops one workspace per event', async () => {
    subscribe(['a', 'b'])
    const stream = await opened(1)
    expect(stream).toMatchObject({ method: 'layout.subscribe', params: { workspaces: ['a', 'b'] } })
    stream.send(
      snapshot([
        { key: 'a', layout: layout('a') },
        { key: 'b', layout: layout('b') }
      ])
    )
    expect(cache).toEqual({ a: layout('a'), b: layout('b') })
    stream.send({ type: 'workspace', key: 'a', layout: layout('a', ['t1']) })
    stream.send({ type: 'removed', key: 'b' })
    // A newer host's frame type is skipped; the stream stays.
    stream.send({ type: 'navigate', request: { focusTab: 't1' } })
    expect(cache).toEqual({ a: layout('a', ['t1']) })
    expect(status).toEqual({ state: 'live' })
    expect(stream.unsubscribed).toBe(false)
  })

  it.each([
    ['a malformed snapshot', { type: 'snapshot', workspaces: [{ key: 'a' }] }],
    ['a malformed workspace', { type: 'workspace', key: 'a', layout: { worktreeId: 'a' } }],
    ['a malformed removed', { type: 'removed', key: '' }],
    ['a frame with no type', { key: 'a' }]
  ])('resubscribes for a fresh snapshot after %s', async (_label, frame) => {
    subscribe()
    const first = await opened(1)
    first.send(snapshot([{ key: 'a', layout: layout('a') }]))
    first.send(frame)
    expect(first.unsubscribed).toBe(true)
    const second = await expectRetryAfter(250)
    second.send(snapshot([{ key: 'b', layout: layout('b') }]))
    expect(cache).toEqual({ b: layout('b') })
  })

  it('resubscribes when a malformed snapshot or a change arrives before the snapshot', async () => {
    subscribe()
    const first = await opened(1)
    first.send({ type: 'workspace', key: 'a', layout: layout('a') })
    expect(first.unsubscribed).toBe(true)
    const second = await expectRetryAfter(250)
    second.send({ type: 'snapshot', workspaces: 'all' })
    expect(second.unsubscribed).toBe(true)
    const third = await expectRetryAfter(500)
    third.send(snapshot([{ key: 'a', layout: layout('a') }]))
    expect(cache).toEqual({ a: layout('a') })
    expect(status).toEqual({ state: 'live' })
  })

  it('after a lost stream, resubscribes and the new snapshot replaces the cache', async () => {
    subscribe()
    const first = await opened(1)
    first.send(
      snapshot([
        { key: 'a', layout: layout('a', ['t1', 't2']) },
        { key: 'b', layout: layout('b') }
      ])
    )
    first.drop()
    expect(first.unsubscribed).toBe(true)
    // The last state stays until the runtime sends a new one; nothing is cleared or guessed.
    expect(cache).toEqual({ a: layout('a', ['t1', 't2']), b: layout('b') })
    const second = await expectRetryAfter(250)
    // A late frame from the dropped stream changes nothing.
    first.send({ type: 'removed', key: 'a' })
    expect(cache).toHaveProperty('a')
    second.send(snapshot([{ key: 'a', layout: layout('a', ['t2']) }]))
    expect(cache).toEqual({ a: layout('a', ['t2']) })
  })

  it('backs off on failed subscribes and error frames, and a snapshot alone does not reset it', async () => {
    host.rejectNextSubscribe()
    subscribe()
    await vi.advanceTimersByTimeAsync(0)
    expect(host.streams).toHaveLength(0)
    const first = await expectRetryAfter(250)
    first.fail('stream failed')
    expect(first.unsubscribed).toBe(true)
    // A host that snapshots then drops at once keeps backing off instead of looping fast.
    let stream = await expectRetryAfter(500)
    for (const delay of [1000, 2000, 4000, 5000, 5000]) {
      stream.send(snapshot())
      stream.drop()
      stream = await expectRetryAfter(delay)
    }
    // A change after the snapshot proves the stream stayed up; the next loss starts over.
    stream.send(snapshot())
    stream.send({ type: 'workspace', key: 'a', layout: layout('a') })
    stream.drop()
    await expectRetryAfter(250)
  })

  it('adds jitter to the retry delay so a shared outage does not resubscribe in lockstep', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    subscribe()
    const first = await opened(1)
    first.drop()
    await expectRetryAfter(275)
  })

  it.each([
    [
      'method_not_found',
      (stream: FakeStream) => stream.fail('no layout stream', 'method_not_found')
    ],
    ['forbidden', (stream: FakeStream) => stream.fail('scope denied', 'forbidden')],
    ['unauthorized', (stream: FakeStream) => stream.fail('pair again', 'unauthorized')]
  ])('stops for good when the host refuses the stream (%s)', async (code, refuse) => {
    const subscription = subscribe()
    const stream = await opened(1)
    stream.send(snapshot([{ key: 'a', layout: layout('a') }]))
    refuse(stream)
    expect(stream.unsubscribed).toBe(true)
    expect(status).toMatchObject({ state: 'refused', code })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.streams).toHaveLength(1)
    // The last state stays; close after a refusal changes nothing.
    expect(cache).toEqual({ a: layout('a') })
    subscription.close()
    expect(status).toMatchObject({ state: 'refused', code })
  })

  it('reads a refusal code that the transport flattened into the message', async () => {
    host.rejectNextSubscribe(
      new Error("Error invoking remote method 'runtime:subscribe': Error: method_not_found")
    )
    subscribe()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.streams).toHaveLength(0)
    expect(status).toMatchObject({ state: 'refused', code: 'method_not_found' })
  })

  it('close unsubscribes, stops retrying and ignores later frames', async () => {
    const subscription = subscribe()
    const stream = await opened(1)
    stream.send(snapshot())
    subscription.close()
    expect(stream.unsubscribed).toBe(true)
    expect(status).toEqual({ state: 'closed' })
    stream.send({ type: 'workspace', key: 'a', layout: layout('a') })
    stream.drop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(host.streams).toHaveLength(1)
    expect(cache).toEqual({})
  })

  it('close while waiting to retry cancels the retry', async () => {
    const subscription = subscribe()
    ;(await opened(1)).drop()
    expect(status).toEqual({ state: 'retrying' })
    subscription.close()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(host.streams).toHaveLength(1)
  })

  it('close before the subscribe settles releases the stream it then gets', async () => {
    const subscription = subscribe()
    subscription.close()
    const stream = await opened(1)
    await vi.waitFor(() => expect(stream.unsubscribed).toBe(true))
  })
})

describe('runtime layout client for a server that is removed or replaced', () => {
  afterEach(() => {
    replaceRuntimeEnvironmentRevisions([])
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('stops for good, whether the stream is live or waiting to retry', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const target: RuntimeClientTarget = { kind: 'environment', environmentId: 'env-1' }
    replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1 }])
    const host = installFakeHost(target)
    let status: RuntimeLayoutStreamStatus | null = null
    const latest = (): RuntimeLayoutStreamStatus | null => status
    subscribeRuntimeLayout(
      target,
      {},
      () => {},
      (next) => {
        status = next
      }
    )
    await vi.waitFor(() => expect(host.streams).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(0)
    const live = host.streams[0]!
    replaceRuntimeEnvironmentRevisions([])
    expect(live.unsubscribed).toBe(true)
    expect(latest()).toMatchObject({ state: 'refused', code: 'runtime_environment_retired' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.streams).toHaveLength(1)

    replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1 }])
    subscribeRuntimeLayout(
      target,
      {},
      () => {},
      (next) => {
        status = next
      }
    )
    await vi.waitFor(() => expect(host.streams).toHaveLength(2))
    await vi.advanceTimersByTimeAsync(0)
    host.streams[1]!.drop()
    expect(latest()).toEqual({ state: 'retrying' })
    replaceRuntimeEnvironmentRevisions([])
    expect(latest()).toMatchObject({ state: 'refused', code: 'runtime_environment_retired' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.streams).toHaveLength(2)
  })
})
