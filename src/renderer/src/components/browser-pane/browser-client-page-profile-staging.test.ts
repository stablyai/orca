// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import {
  createRetainedHostFixture,
  RETAINED_FIXTURE_PAGE
} from './browser-client-page-retained-host-fixture'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('retained profile replacement staging', () => {
  it('keeps the old visible guest alive while another partition mounts under the same page id', async () => {
    const fixture = createRetainedHostFixture()
    await fixture.mount()
    const old = fixture.attach()
    const oldWebview = old.webview
    const next = { ...RETAINED_FIXTURE_PAGE, partition: 'persist:route-b', pageHostGeneration: 4 }
    await fixture.mount(next)
    expect(oldWebview.isConnected).toBe(true)
    expect(fixture.registry.getMemoryProfile()).toMatchObject({ attachedPageCount: 2 })
    fixture.registry.retirePage(next)
    expect(oldWebview.isConnected).toBe(true)
    expect(() => old.nextMetadataRevision()).not.toThrow()
    old.detach()
    fixture.registry.dispose()
  })
})
