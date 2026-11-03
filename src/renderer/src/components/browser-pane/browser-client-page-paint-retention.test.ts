// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { setRemoteViewersForBrowserPage } from '../../lib/pane-manager/browser-remote-viewer-state'
import {
  createRetainedHostFixture,
  disposeRetainedHostFixtures
} from './browser-client-page-retained-host-fixture'

afterEach(() => {
  disposeRetainedHostFixtures()
  setRemoteViewersForBrowserPage('page-a', false)
  document.body.innerHTML = ''
})

it('keeps a streamed retained guest invisible and inert across desktop attach and detach', async () => {
  const rig = createRetainedHostFixture()
  await rig.mount()
  setRemoteViewersForBrowserPage('page-a', true)
  const host = rig.host()
  expect(host.style.left).toBe('0px')
  expect(Number.parseInt(host.style.width)).toBeGreaterThanOrEqual(320)
  expect(host.style.opacity).toBe('0')
  expect(host.inert).toBe(true)
  expect(host.style.pointerEvents).toBe('none')

  const attachment = rig.attach()
  expect(host.style.opacity).toBe('')
  expect(host.inert).toBe(false)
  vi.spyOn(rig.container, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 0, 0))
  setRemoteViewersForBrowserPage('page-a', true)
  expect(Number.parseInt(host.style.width)).toBeGreaterThanOrEqual(320)
  expect(host.style.opacity).toBe('0')
  attachment.detach()
  host
    .querySelector('webview')!
    .dispatchEvent(
      Object.assign(new Event('load-commit'), { url: 'about:blank', isMainFrame: true })
    )
  expect(host.style.visibility).toBe('')
  expect(host.style.opacity).toBe('0')
  expect(host.inert).toBe(true)
  expect(host.style.pointerEvents).toBe('none')

  setRemoteViewersForBrowserPage('page-a', false)
  expect(host.style.width).toBe('1px')
  rig.registry.dispose()
  setRemoteViewersForBrowserPage('page-a', true)
  expect(host.style.width).toBe('1px')
})
