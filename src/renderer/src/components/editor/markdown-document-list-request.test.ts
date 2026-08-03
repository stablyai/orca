import { describe, expect, it, vi } from 'vitest'
import type { MarkdownDocument } from '../../../../shared/types'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import {
  getMarkdownDocumentListRequestKey,
  requestSharedMarkdownDocumentList
} from './markdown-document-list-request'

function context(overrides: Partial<RuntimeFileOperationArgs> = {}): RuntimeFileOperationArgs {
  return {
    settings: { activeRuntimeEnvironmentId: null },
    worktreeId: 'worktree-1',
    worktreePath: '/repo',
    ...overrides
  }
}

function deferred<T>(): {
  promise: Promise<T>
  reject: (error: Error) => void
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

describe('shared Markdown document list requests', () => {
  it('collapses concurrent pane scans and releases the result after settlement', async () => {
    const pending = deferred<MarkdownDocument[]>()
    const load = vi.fn(() => pending.promise)
    const requests = Array.from({ length: 200 }, () =>
      requestSharedMarkdownDocumentList(context(), '/repo', {}, load)
    )

    expect(load).toHaveBeenCalledTimes(1)
    expect(new Set(requests).size).toBe(1)

    const documents = [{ filePath: '/repo/README.md', relativePath: 'README.md' }]
    pending.resolve(documents as MarkdownDocument[])
    await expect(Promise.all(requests)).resolves.toEqual(
      Array.from({ length: 200 }, () => documents)
    )

    const nextDocuments = [{ filePath: '/repo/notes.md', relativePath: 'notes.md' }]
    load.mockResolvedValueOnce(nextDocuments as MarkdownDocument[])
    await expect(requestSharedMarkdownDocumentList(context(), '/repo', {}, load)).resolves.toBe(
      nextDocuments
    )
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('starts a fresh scan after a mutation instead of joining an older snapshot', async () => {
    const stale = deferred<MarkdownDocument[]>()
    const fresh = deferred<MarkdownDocument[]>()
    const load = vi.fn().mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise)

    const initialRequest = requestSharedMarkdownDocumentList(context(), '/repo', {}, load)
    const mutationRefresh = requestSharedMarkdownDocumentList(
      context(),
      '/repo',
      { requireFresh: true },
      load
    )

    expect(load).toHaveBeenCalledTimes(2)
    expect(mutationRefresh).not.toBe(initialRequest)

    const freshDocuments = [{ filePath: '/repo/new.md', relativePath: 'new.md' }]
    fresh.resolve(freshDocuments as MarkdownDocument[])
    await expect(mutationRefresh).resolves.toBe(freshDocuments)

    const staleDocuments = [{ filePath: '/repo/old.md', relativePath: 'old.md' }]
    stale.resolve(staleDocuments as MarkdownDocument[])
    await expect(initialRequest).resolves.toBe(staleDocuments)
  })

  it('allows an ordinary retry after an older scan stops settling', async () => {
    const stale = deferred<MarkdownDocument[]>()
    const retry = deferred<MarkdownDocument[]>()
    const load = vi.fn().mockReturnValueOnce(stale.promise).mockReturnValueOnce(retry.promise)
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000)

    try {
      const initialRequest = requestSharedMarkdownDocumentList(context(), '/stuck', {}, load)
      now.mockReturnValue(31_001)
      const retryRequest = requestSharedMarkdownDocumentList(context(), '/stuck', {}, load)

      expect(load).toHaveBeenCalledTimes(2)
      expect(retryRequest).not.toBe(initialRequest)

      retry.resolve([])
      stale.resolve([])
      await expect(retryRequest).resolves.toEqual([])
      await expect(initialRequest).resolves.toEqual([])
    } finally {
      now.mockRestore()
    }
  })

  it('evicts an abandoned scan for a route that is never requested again', async () => {
    const abandoned = deferred<MarkdownDocument[]>()
    const load = vi.fn().mockReturnValueOnce(abandoned.promise).mockResolvedValueOnce([])
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000)

    try {
      const abandonedRequest = requestSharedMarkdownDocumentList(
        context(),
        '/abandoned-only',
        {},
        load
      )
      now.mockReturnValue(31_001)
      // A request for a different route sweeps the expired entry so the map
      // does not pin the abandoned promise for the renderer's lifetime.
      await expect(
        requestSharedMarkdownDocumentList(context(), '/other-route', {}, load)
      ).resolves.toEqual([])

      load.mockResolvedValueOnce([])
      await expect(
        requestSharedMarkdownDocumentList(context(), '/abandoned-only', {}, load)
      ).resolves.toEqual([])
      expect(load).toHaveBeenCalledTimes(3)

      abandoned.resolve([])
      await expect(abandonedRequest).resolves.toEqual([])
    } finally {
      now.mockRestore()
    }
  })

  it('keeps runtime routes isolated and encodes unusual paths losslessly', () => {
    const local = context()
    const ssh = context({ connectionId: 'ssh-1' })
    const runtime = context({ settings: { activeRuntimeEnvironmentId: ' runtime-1 ' } })
    const unusualRoot = '/repo\nwith-newline'
    const windowsRoot = 'C:\\repo\\docs'
    const uncRoot = '\\\\server\\share\\repo'

    expect(getMarkdownDocumentListRequestKey(local, unusualRoot)).not.toBe(
      getMarkdownDocumentListRequestKey(ssh, unusualRoot)
    )
    expect(getMarkdownDocumentListRequestKey(ssh, unusualRoot)).not.toBe(
      getMarkdownDocumentListRequestKey(runtime, unusualRoot)
    )
    expect(JSON.parse(getMarkdownDocumentListRequestKey(local, unusualRoot)).at(-1)).toBe(
      unusualRoot
    )
    expect(JSON.parse(getMarkdownDocumentListRequestKey(local, windowsRoot)).at(-1)).toBe(
      windowsRoot
    )
    expect(JSON.parse(getMarkdownDocumentListRequestKey(local, uncRoot)).at(-1)).toBe(uncRoot)
  })

  it('clears rejected requests so a retry can run', async () => {
    const failure = deferred<MarkdownDocument[]>()
    const load = vi.fn(() => failure.promise)
    const first = requestSharedMarkdownDocumentList(context(), '/retry', {}, load)
    const second = requestSharedMarkdownDocumentList(context(), '/retry', {}, load)

    failure.reject(new Error('offline'))
    await expect(first).rejects.toThrow('offline')
    await expect(second).rejects.toThrow('offline')

    load.mockResolvedValueOnce([])
    await expect(requestSharedMarkdownDocumentList(context(), '/retry', {}, load)).resolves.toEqual(
      []
    )
    expect(load).toHaveBeenCalledTimes(2)
  })
})
