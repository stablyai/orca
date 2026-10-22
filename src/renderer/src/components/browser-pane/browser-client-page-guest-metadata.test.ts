import { describe, expect, it, vi } from 'vitest'
import { bindBrowserClientPageGuestEvents } from './browser-client-page-guest-metadata'

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({ recordRendererCrashBreadcrumb: vi.fn() }))

describe('bindBrowserClientPageGuestEvents', () => {
  it('binds the six mirrored guest events and unbinds exactly those handlers', () => {
    const guest = new EventTarget()
    const add = vi.spyOn(guest, 'addEventListener')
    const remove = vi.spyOn(guest, 'removeEventListener')
    const onStart = vi.fn()
    const syncNavigation = vi.fn()
    const onFailLoad = vi.fn()

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: binding only calls addEventListener and removeEventListener, which an EventTarget provides.
    const webview = guest as unknown as Electron.WebviewTag

    const unbind = bindBrowserClientPageGuestEvents(webview, onStart, syncNavigation, onFailLoad)

    expect(add.mock.calls).toEqual([
      ['did-start-navigation', onStart],
      ['did-stop-loading', syncNavigation],
      ['did-navigate', syncNavigation],
      ['did-navigate-in-page', syncNavigation],
      ['page-title-updated', syncNavigation],
      ['did-fail-load', onFailLoad]
    ])
    expect(remove).not.toHaveBeenCalled()

    unbind()

    expect(remove.mock.calls).toEqual(add.mock.calls)
    for (const [type] of add.mock.calls) {
      guest.dispatchEvent(new Event(type))
    }
    expect(onStart).not.toHaveBeenCalled()
    expect(syncNavigation).not.toHaveBeenCalled()
    expect(onFailLoad).not.toHaveBeenCalled()
  })
})
