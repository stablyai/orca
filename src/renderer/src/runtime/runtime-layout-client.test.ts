import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublishedWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-published'
import {
  applyLayoutFrame,
  EMPTY_WORKSPACE_LAYOUT_CACHE,
  type WorkspaceLayoutCache
} from '../store/workspace-layout-cache'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
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
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    host = installFakeHost(target)
    cache = EMPTY_WORKSPACE_LAYOUT_CACHE
    status = null
  })

  afterEach(() => {
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

  it('ignores a change before the snapshot and unknown frame types', async () => {
    subscribe()
    const stream = await opened(1)
    stream.send({ type: 'workspace', key: 'a', layout: layout('a') })
    stream.send(snapshot())
    stream.send({ type: 'navigate', request: { focusTab: 't1' } })
    expect(cache).toEqual({})
    expect(stream.unsubscribed).toBe(false)
  })

  it('reports every frame’s position, an unreadable frame’s and a throwing reader’s too', async () => {
    const positions: number[] = []
    let throwOnFrame = false
    subscribeRuntimeLayout(
      target,
      {},
      () => {
        if (throwOnFrame) {
          throw new Error('reader failed')
        }
      },
      () => {},
      (seq) => positions.push(seq)
    )
    const stream = await opened(1)
    stream.send({ ...snapshot(), seq: 3 })
    stream.send({ type: 'navigate', request: {}, seq: 4 })
    throwOnFrame = true
    expect(() => stream.send({ type: 'removed', key: 'a', seq: 5 })).toThrow('reader failed')
    // A frame with no position, as an older host sends, reports none.
    throwOnFrame = false
    stream.send({ type: 'removed', key: 'a' })
    expect(positions).toEqual([3, 4, 5])
    // A malformed frame sends the stream back for a snapshot, whose position covers it.
    stream.send({ type: 'workspace', key: 'a', layout: { worktreeId: 'a' }, seq: 6 })
    expect(positions).toEqual([3, 4, 5])
    ;(await opened(2)).send({ ...snapshot(), seq: 7 })
    expect(positions).toEqual([3, 4, 5, 7])
  })

  it.each([
    [
      'method_not_found',
      (stream: FakeStream) => stream.fail('no layout stream', 'method_not_found')
    ],
    ['forbidden', (stream: FakeStream) => stream.fail('scope denied', 'forbidden')]
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

  it('close unsubscribes and ignores later frames', async () => {
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

  it('close before the subscribe settles releases the stream it then gets', async () => {
    const subscription = subscribe()
    subscription.close()
    const stream = await opened(1)
    await vi.waitFor(() => expect(stream.unsubscribed).toBe(true))
  })
})

describe.each(targets)(
  'a records stream over the %s transport that misses a frame',
  (_name, target) => {
    let host: FakeHost
    let cache: WorkspaceLayoutCache
    let statuses: RuntimeLayoutStreamStatus[]

    beforeEach(() => {
      vi.useFakeTimers()
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      host = installFakeHost(target)
      cache = EMPTY_WORKSPACE_LAYOUT_CACHE
      statuses = []
      subscribeRuntimeLayout(
        target,
        {},
        (frame) => {
          cache = applyLayoutFrame(cache, frame)
        },
        (next) => statuses.push(next)
      )
    })

    afterEach(() => {
      vi.useRealTimers()
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    })

    async function opened(count: number): Promise<FakeStream> {
      await vi.waitFor(() => expect(host.streams).toHaveLength(count))
      await vi.advanceTimersByTimeAsync(0)
      return host.streams[count - 1]!
    }

    const snapshot = (epoch: string, seq: number, worktreeIds: string[]) => ({
      type: 'snapshot',
      subscriptionId: 'layout-1',
      epoch,
      seq,
      workspaces: worktreeIds.map((id) => ({ key: id, layout: layout(id) }))
    })

    /** One operation's frame: workspace `key`'s groups now hold `tabIds`. */
    const regrouped = (epoch: string, seq: number, key: string, tabIds: string[]) => ({
      type: 'records',
      epoch,
      seq,
      workspaces: [
        {
          key,
          change: 'records',
          workspace: { worktreeId: key, groups: [{ id: `group-${key}`, tabIds }] }
        }
      ]
    })

    it('applies each records frame in sequence to the snapshot', async () => {
      const stream = await opened(1)
      stream.send(snapshot('epoch-1', 3, ['a', 'b']))
      stream.send(regrouped('epoch-1', 4, 'a', ['t1']))
      stream.send(regrouped('epoch-1', 5, 'b', ['t2']))
      expect(cache).toEqual({ a: layout('a', ['t1']), b: layout('b', ['t2']) })
      expect(stream.unsubscribed).toBe(false)
      expect(host.streams).toHaveLength(1)
    })

    it('counts a skipped frame of a newer type as a position, so the next frame is no gap', async () => {
      const stream = await opened(1)
      stream.send(snapshot('epoch-1', 3, ['a']))
      stream.send({ type: 'navigate', request: {}, seq: 4 })
      stream.send(regrouped('epoch-1', 5, 'a', ['t1']))
      expect(cache).toEqual({ a: layout('a', ['t1']) })
      expect(host.streams).toHaveLength(1)
    })

    it('stops resubscribing at once when every fresh stream fails, and backs off', async () => {
      const bad = { type: 'records', epoch: 'epoch-1', seq: 4, workspaces: 'a' }
      for (let count = 1; count <= 4; count += 1) {
        const stream = await opened(count)
        stream.send(snapshot('epoch-1', 3, ['a']))
        stream.send(bad)
      }
      // Three immediate resubscribes; the fourth failure takes the loss path.
      expect(statuses.at(-1)).toEqual({ state: 'lost' })
      expect(host.streams).toHaveLength(4)
      await vi.advanceTimersByTimeAsync(999)
      expect(host.streams).toHaveLength(4)
      await vi.advanceTimersByTimeAsync(1)
      expect(host.streams).toHaveLength(5)
      // Still failing: the reopened stream's snapshot keeps the backoff growing.
      const fifth = await opened(5)
      fifth.send(snapshot('epoch-1', 3, ['a']))
      fifth.send(bad)
      await vi.advanceTimersByTimeAsync(1999)
      expect(host.streams).toHaveLength(5)
      await vi.advanceTimersByTimeAsync(1)
      expect(host.streams).toHaveLength(6)
      // A clean change ends the storm: the next drop reopens after 1 s again.
      const sixth = await opened(6)
      sixth.send(snapshot('epoch-1', 3, ['a']))
      sixth.send(regrouped('epoch-1', 4, 'a', ['t1']))
      sixth.drop()
      await vi.advanceTimersByTimeAsync(999)
      expect(host.streams).toHaveLength(6)
      await vi.advanceTimersByTimeAsync(1)
      expect(host.streams).toHaveLength(7)
    })

    it('starts the backoff over after one resync, once the stream is healthy again', async () => {
      const first = await opened(1)
      first.send(snapshot('epoch-1', 3, ['a']))
      first.send(regrouped('epoch-1', 5, 'a', ['t1']))
      const second = await opened(2)
      second.send(snapshot('epoch-1', 9, ['a']))
      // Two unrelated drops, each followed by a healthy snapshot, each reopen after 1 s.
      for (let count = 3; count <= 4; count += 1) {
        host.streams.at(-1)!.drop()
        await vi.advanceTimersByTimeAsync(999)
        expect(host.streams).toHaveLength(count - 1)
        await vi.advanceTimersByTimeAsync(1)
        expect(host.streams).toHaveLength(count)
        ;(await opened(count)).send(snapshot('epoch-1', 9, ['a']))
      }
    })

    it.each([
      ['an epoch change', regrouped('epoch-2', 4, 'a', ['t1'])],
      ['a position that skips one', regrouped('epoch-1', 5, 'a', ['t1'])],
      [
        'an unreadable records frame',
        { type: 'records', epoch: 'epoch-1', seq: 4, workspaces: 'a' }
      ],
      ['records for a workspace never shown', regrouped('epoch-1', 4, 'z', ['t1'])]
    ])('resubscribes exactly once after %s and takes the fresh snapshot', async (_case, frame) => {
      const first = await opened(1)
      first.send(snapshot('epoch-1', 3, ['a', 'b']))

      first.send(frame)
      expect(first.unsubscribed).toBe(true)
      const second = await opened(2)
      // A frame the dropped stream still delivers changes nothing.
      first.send(regrouped('epoch-1', 4, 'a', ['late']))
      second.send(snapshot('epoch-2', 9, ['a']))

      expect(cache).toEqual({ a: layout('a') })
      second.send(regrouped('epoch-2', 10, 'a', ['t1']))
      expect(cache).toEqual({ a: layout('a', ['t1']) })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(host.streams).toHaveLength(2)
      expect(second.unsubscribed).toBe(false)
      // The window never sees the stream as lost: it resubscribed at once.
      expect(statuses.map((status) => status.state)).toEqual([
        'connecting',
        'live',
        'connecting',
        'live'
      ])
    })
  }
)

describe.each(targets)('the %s layout stream after a loss', (_name, target) => {
  let host: FakeHost
  let cache: WorkspaceLayoutCache
  let statuses: RuntimeLayoutStreamStatus[]

  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    host = installFakeHost(target)
    cache = EMPTY_WORKSPACE_LAYOUT_CACHE
    statuses = []
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const subscribe = () =>
    subscribeRuntimeLayout(
      target,
      {},
      (frame) => {
        cache = applyLayoutFrame(cache, frame)
      },
      (next) => {
        statuses.push(next)
      }
    )

  async function opened(count: number): Promise<FakeStream> {
    await vi.waitFor(() => expect(host.streams).toHaveLength(count))
    await vi.advanceTimersByTimeAsync(0)
    return host.streams[count - 1]!
  }

  const snapshot = (workspaces: { key: string; layout: PublishedWorkspaceLayout }[]) => ({
    type: 'snapshot',
    subscriptionId: 'layout-1',
    workspaces
  })

  it('reopens it, and the new snapshot replaces the cache', async () => {
    subscribe()
    const first = await opened(1)
    first.send(
      snapshot([
        { key: 'a', layout: layout('a') },
        { key: 'b', layout: layout('b') }
      ])
    )
    first.drop()
    expect(statuses.at(-1)).toEqual({ state: 'lost' })

    await vi.advanceTimersByTimeAsync(1_000)
    const second = await opened(2)
    expect(statuses.at(-1)).toEqual({ state: 'connecting' })
    second.send(snapshot([{ key: 'a', layout: layout('a', ['t1']) }]))
    expect(statuses.at(-1)).toEqual({ state: 'live' })
    expect(cache).toEqual({ a: layout('a', ['t1']) })
    // A late frame from the dropped stream changes nothing.
    first.send({ type: 'removed', key: 'a' })
    expect(cache).toEqual({ a: layout('a', ['t1']) })
  })

  it('waits longer after each failed reopen, and close stops a pending one', async () => {
    const subscription = subscribe()
    ;(await opened(1)).drop()
    host.rejectNextSubscribe()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(statuses.at(-1)).toEqual({ state: 'lost' })
    await vi.advanceTimersByTimeAsync(1_999)
    expect(host.streams).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await opened(2)
    host.streams[1]!.drop()
    subscription.close()
    expect(statuses.at(-1)).toEqual({ state: 'closed' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.streams).toHaveLength(2)
  })

  it('reopens after an error frame', async () => {
    subscribe()
    ;(await opened(1)).fail('stream failed')
    expect(statuses.at(-1)).toEqual({ state: 'lost' })
    await vi.advanceTimersByTimeAsync(1_000)
    ;(await opened(2)).send(snapshot([{ key: 'a', layout: layout('a') }]))
    expect(statuses.at(-1)).toEqual({ state: 'live' })
  })

  it('never reopens after a refusal', async () => {
    subscribe()
    ;(await opened(1)).fail('no layout stream', 'method_not_found')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(host.streams).toHaveLength(1)
  })
})
