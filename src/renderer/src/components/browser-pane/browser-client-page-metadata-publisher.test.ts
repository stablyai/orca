import { describe, expect, it, vi } from 'vitest'
import { createBrowserClientPageMetadataPublisher } from './browser-client-page-metadata-publisher'

const PLACEMENT = {
  kind: 'client' as const,
  browserHostClientId: 'host-a',
  browserHostGeneration: 3,
  pageHostGeneration: 7
}

describe('browser client page metadata publisher', () => {
  it('keeps one call in flight and coalesces to the latest full snapshot', async () => {
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    const publish = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    let revision = 0
    const publisher = createBrowserClientPageMetadataPublisher({
      browserPageId: 'page-a',
      placement: PLACEMENT,
      nextRevision: () => ++revision,
      publish
    })

    publisher.publish(snapshot('First'))
    publisher.publish(snapshot('Second'))
    publisher.publish(snapshot('Latest'))

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ revision: 1, title: 'First' })
    )
    first.resolve({ status: 'published', accepted: true })
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2))
    expect(publish).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ revision: 2, title: 'Latest' })
    )
    second.resolve({ status: 'published', accepted: true })
  })

  it('drops pending work after disposal without starting another call', async () => {
    const first = deferred<unknown>()
    const publish = vi.fn().mockReturnValue(first.promise)
    let revision = 0
    const publisher = createBrowserClientPageMetadataPublisher({
      browserPageId: 'page-a',
      placement: PLACEMENT,
      nextRevision: () => ++revision,
      publish
    })

    publisher.publish(snapshot('First'))
    publisher.publish(snapshot('Pending'))
    publisher.dispose()
    first.resolve({ status: 'published', accepted: true })
    await Promise.resolve()

    expect(publish).toHaveBeenCalledTimes(1)
  })

  // Why a throwing revision is not hypothetical: nextRevision throws whenever the page it counts
  // for has been detached, which is exactly what a pane teardown racing an in-flight publish does.
  it('keeps publishing after the revision counter throws', async () => {
    const publish = vi.fn().mockResolvedValue({ status: 'published', accepted: true })
    let revision = 0
    const nextRevision = vi.fn(() => {
      revision += 1
      if (revision === 1) {
        throw new Error('browser_client_page_renderer_visible_page_detached')
      }
      return revision
    })
    const publisher = createBrowserClientPageMetadataPublisher({
      browserPageId: 'page-a',
      placement: PLACEMENT,
      nextRevision,
      publish
    })

    expect(() => publisher.publish(snapshot('Throws'))).not.toThrow()
    expect(publish).not.toHaveBeenCalled()

    publisher.publish(snapshot('Later'))
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1))
    expect(publish).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ revision: 2, title: 'Later' })
    )
  })

  it('reports a publish the runtime refused instead of discarding it', async () => {
    const onUnpublished = vi.fn()
    const publish = vi
      .fn()
      .mockResolvedValueOnce({ status: 'published', accepted: false })
      .mockResolvedValueOnce({ status: 'failed', errorCode: 'browser_host_lease_stale' })
    let revision = 0
    const publisher = createBrowserClientPageMetadataPublisher({
      browserPageId: 'page-a',
      placement: PLACEMENT,
      nextRevision: () => ++revision,
      publish,
      onUnpublished
    })

    publisher.publish(snapshot('Refused'))
    await vi.waitFor(() => expect(onUnpublished).toHaveBeenCalledTimes(1))
    expect(onUnpublished).toHaveBeenNthCalledWith(1, { reason: 'rejected' })

    publisher.publish(snapshot('Failed'))
    await vi.waitFor(() => expect(onUnpublished).toHaveBeenCalledTimes(2))
    expect(onUnpublished).toHaveBeenNthCalledWith(2, {
      reason: 'failed',
      errorCode: 'browser_host_lease_stale'
    })
  })

  // Why a rejection needs its own case: a publish that never reaches the runtime rejects rather
  // than answering, so the reported-outcome path and the thrown path are different code.
  it('reports a publish that threw on its way out', async () => {
    const onUnpublished = vi.fn()
    let revision = 0
    const publisher = createBrowserClientPageMetadataPublisher({
      browserPageId: 'page-a',
      placement: PLACEMENT,
      nextRevision: () => ++revision,
      publish: () => Promise.reject(new Error('remote_runtime_unavailable')),
      onUnpublished
    })

    publisher.publish(snapshot('Thrown'))
    await vi.waitFor(() => expect(onUnpublished).toHaveBeenCalledTimes(1))
    expect(onUnpublished).toHaveBeenNthCalledWith(1, {
      reason: 'failed',
      errorCode: 'remote_runtime_unavailable'
    })
  })
})

function snapshot(title: string) {
  return {
    url: 'https://example.com/',
    title,
    loading: false,
    canGoBack: true,
    canGoForward: false
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
