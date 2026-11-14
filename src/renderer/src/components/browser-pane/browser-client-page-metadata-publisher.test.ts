import { describe, expect, it, vi } from 'vitest'
import { BrowserClientPageMetadataParams } from '../../../../shared/browser/client-hosting/browser-client-page-metadata-protocol'
import { createBrowserClientPageMetadataPublisher } from './browser-client-page-metadata-publisher'

const PLACEMENT = {
  kind: 'client' as const,
  browserHostClientId: 'host-a',
  browserHostGeneration: 3,
  pageHostGeneration: 7
}

describe('browser client page metadata publisher', () => {
  it('publishes an untitled long URL within the title wire limit without changing the source', () => {
    const url = `https://example.com/${'a'.repeat(4080)}`
    const source = { ...snapshot(url), url }
    const publish = vi.fn().mockResolvedValue({ status: 'published', accepted: true })
    const publisher = createBrowserClientPageMetadataPublisher({
      browserPageId: 'page-a',
      placement: PLACEMENT,
      nextRevision: () => 1,
      publish
    })

    publisher.publish(source)

    expect(BrowserClientPageMetadataParams.parse(publish.mock.calls[0][0])).toMatchObject({
      url,
      title: `https://example.com/${'a'.repeat(4076)}`,
      loading: false,
      canGoBack: true,
      canGoForward: false
    })
    expect(source).toEqual({ ...snapshot(url), url })
  })

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

  // nextRevision throws after detach, so pane teardown can fail before publish even starts.
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
