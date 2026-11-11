import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublishedWorkspaceLayout } from '../../../../../shared/workspace-layout/workspace-layout-published'
import {
  applyLayoutFrame,
  EMPTY_WORKSPACE_LAYOUT_CACHE,
  type WorkspaceLayoutCache
} from '../../../store/workspace-layout/workspace-layout-cache'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
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

    it('counts a skipped frame of a newer type as a position, so the next frame is no gap', async () => {
      const stream = await opened(1)
      stream.send(snapshot('epoch-1', 3, ['a']))
      stream.send({ type: 'navigate', request: {}, seq: 4 })
      stream.send(regrouped('epoch-1', 5, 'a', ['t1']))
      expect(cache).toEqual({ a: layout('a', ['t1']) })
      expect(host.streams).toHaveLength(1)
    })
  }
)
