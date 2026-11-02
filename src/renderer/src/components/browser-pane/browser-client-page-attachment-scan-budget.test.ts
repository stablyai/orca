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

describe('retained browser page attachment lookup', () => {
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
