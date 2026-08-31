// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
// Imported through the registry the way the drag lifecycle imports it, so these drive the entry
// point the shipping gesture actually calls.
import {
  acquireWebviewsDragPassthrough,
  registerPersistentWebview,
  unregisterPersistentWebview
} from './host-guest/webview-registry'
import {
  createRetainedHostFixture,
  disposeRetainedHostFixtures
} from './browser-client-page-retained-host-fixture'

const openReleases: (() => void)[] = []

/** Stands in for a tab or terminal drag holding every guest surface click-through. */
function startDrag(): () => void {
  const release = acquireWebviewsDragPassthrough()
  openReleases.push(release)
  return release
}

afterEach(() => {
  for (const release of openReleases.splice(0)) {
    release()
  }
  disposeRetainedHostFixtures()
  document.body.innerHTML = ''
})

describe('client-hosted retained guest drag passthrough', () => {
  it('holds a visible retained host click-through for the length of a drag', async () => {
    const rig = createRetainedHostFixture()
    await rig.mount()
    rig.attach()
    expect(rig.host().style.pointerEvents).toBe('auto')

    const endDrag = startDrag()

    expect(rig.host().style.pointerEvents).toBe('none')

    endDrag()

    expect(rig.host().style.pointerEvents).toBe('auto')
  })

  it('brings a retained page attached mid-drag up click-through', async () => {
    const rig = createRetainedHostFixture()
    await rig.mount()
    const endDrag = startDrag()

    rig.attach()

    expect(rig.host().style.pointerEvents).toBe('none')

    endDrag()

    expect(rig.host().style.pointerEvents).toBe('auto')
  })

  it('brings a retained page created mid-drag up click-through', async () => {
    const rig = createRetainedHostFixture()
    const endDrag = startDrag()
    await rig.mount()

    rig.attach()

    expect(rig.host().style.pointerEvents).toBe('none')

    endDrag()

    expect(rig.host().style.pointerEvents).toBe('auto')
  })

  it('keeps the retained host click-through until every drag releases', async () => {
    const rig = createRetainedHostFixture()
    await rig.mount()
    rig.attach()

    const endTabDrag = startDrag()
    const endTerminalDrag = startDrag()

    expect(rig.host().style.pointerEvents).toBe('none')

    endTabDrag()

    expect(rig.host().style.pointerEvents).toBe('none')

    endTerminalDrag()
    endTerminalDrag()

    expect(rig.host().style.pointerEvents).toBe('auto')
  })

  it('restores click-through after a drag that spans a hide and a show', async () => {
    const rig = createRetainedHostFixture()
    await rig.mount()
    const firstAttachment = rig.attach()
    const endDrag = startDrag()

    // A pane that goes inactive and active again mid-drag rewrites the same property the drag owns.
    firstAttachment.detach()
    expect(rig.host().style.pointerEvents).toBe('none')
    rig.attach()
    expect(rig.host().style.pointerEvents).toBe('none')

    endDrag()

    expect(rig.host().style.pointerEvents).toBe('auto')
  })

  it('leaves a host hidden mid-drag click-through-free once the drag ends', async () => {
    const rig = createRetainedHostFixture()
    await rig.mount()
    const attachment = rig.attach()
    const endDrag = startDrag()
    expect(rig.host().style.pointerEvents).toBe('none')

    attachment.detach()
    endDrag()

    expect(rig.host().style.pointerEvents).toBe('none')
  })

  it('covers the local and client-hosted surfaces from one acquire', async () => {
    const rig = createRetainedHostFixture()
    await rig.mount()
    rig.attach()
    const localWebview = document.createElement('webview') as Electron.WebviewTag
    localWebview.style.pointerEvents = 'auto'
    registerPersistentWebview('local-page', localWebview)

    const endDrag = startDrag()

    expect(localWebview.style.pointerEvents).toBe('none')
    expect(rig.host().style.pointerEvents).toBe('none')

    endDrag()

    expect(localWebview.style.pointerEvents).toBe('auto')
    expect(rig.host().style.pointerEvents).toBe('auto')
    unregisterPersistentWebview('local-page')
  })

  it('stops driving a host whose page has been released', async () => {
    const rig = createRetainedHostFixture()
    await rig.mount()
    rig.attach()
    const host = rig.host()

    rig.registry.dispose()
    const endDrag = startDrag()

    expect(host.style.pointerEvents).toBe('auto')

    endDrag()
  })
})
