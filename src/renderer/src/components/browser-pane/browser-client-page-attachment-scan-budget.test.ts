// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createRetainedHostFixture,
  disposeRetainedHostFixtures,
  RETAINED_FIXTURE_PAGE
} from './browser-client-page-retained-host-fixture'

afterEach(() => {
  vi.restoreAllMocks()
  disposeRetainedHostFixtures()
  document.body.innerHTML = ''
})

function observePageIterations(pages: Map<unknown, unknown>): {
  count: () => number
  reset: () => void
} {
  let steps = 0
  const values = Map.prototype.values
  vi.spyOn(Map.prototype, 'values').mockImplementation(function (this: Map<unknown, unknown>) {
    const iterator = values.call(this)
    if (this !== pages) {
      return iterator
    }
    const next = iterator.next.bind(iterator)
    vi.spyOn(iterator, 'next').mockImplementation(() => {
      steps += 1
      return next()
    })
    return iterator
  })
  return {
    count: () => steps,
    reset: () => {
      steps = 0
    }
  }
}

describe('retained browser page attachment lookup', () => {
  it('stops at early, middle and last matches without copying the complete page catalog', async () => {
    const fixture = createRetainedHostFixture()
    const identities = Array.from({ length: 256 }, (_, index) => ({
      ...RETAINED_FIXTURE_PAGE,
      partition: `persist:route-${Math.floor(index / 64)}`,
      browserPageId: `page-${index}`
    }))
    for (const identity of identities) {
      await fixture.mount(identity)
    }
    const registry: unknown = fixture.registry
    if (
      typeof registry !== 'object' ||
      registry === null ||
      !('pages' in registry) ||
      !(registry.pages instanceof Map)
    ) {
      throw new Error('Retained page catalog is not a Map')
    }
    const iterations = observePageIterations(registry.pages)
    const counts: number[] = []
    for (const index of [0, 127, 255]) {
      iterations.reset()
      const attachment = fixture.attach(identities[index])
      expect(attachment.webview.getWebContentsId()).toBe(index + 41)
      expect(attachment.nextMetadataRevision()).toBe(1)
      expect([...new Map([['unrelated', index]]).values()]).toEqual([index])
      counts.push(iterations.count())
      attachment.detach()
    }
    iterations.reset()
    expect(() => fixture.attach(RETAINED_FIXTURE_PAGE)).toThrow(
      'browser_client_page_renderer_visible_page_unavailable'
    )
    counts.push(iterations.count())
    expect(counts).toEqual([1, 128, 256, 257])
  })

  it('keeps the first matching partition and follows exact generations after rekey and destruction', async () => {
    const fixture = createRetainedHostFixture()
    const first = RETAINED_FIXTURE_PAGE
    const second = { ...first, partition: 'persist:second' }
    await fixture.mount(first)
    await fixture.mount(second)
    const visible = fixture.attach(first)
    expect(visible.webview.getWebContentsId()).toBe(41)
    expect(() => fixture.attach(second)).toThrow(
      'browser_client_page_renderer_visible_page_claimed'
    )
    visible.detach()
    const rekeyed = { ...first, pageHostGeneration: first.pageHostGeneration + 1 }
    fixture.registry.rekeyPage(first, rekeyed)

    const oldGeneration = fixture.attach(first)
    expect(oldGeneration.webview.getWebContentsId()).toBe(42)
    oldGeneration.detach()
    const newGeneration = fixture.attach(rekeyed)
    expect(newGeneration.webview).toBe(visible.webview)
    fixture.registry.retirePage(rekeyed)
    newGeneration.detach()
    expect(() => fixture.attach(rekeyed)).toThrow(
      'browser_client_page_renderer_visible_page_unavailable'
    )
    visible.webview.dispatchEvent(new Event('destroyed'))
    await fixture.mount(rekeyed)
    const replacement = fixture.attach(rekeyed)
    expect(replacement.webview.getWebContentsId()).toBe(43)
    expect(replacement.webview).not.toBe(visible.webview)
    replacement.detach()
    fixture.registry.dispose()
    expect(() => fixture.attach(rekeyed)).toThrow(
      'browser_client_page_renderer_visible_page_unavailable'
    )
  })
})
