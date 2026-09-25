// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  BrowserClientPageRendererOutcome,
  BrowserClientPageRendererRequest
} from '../../../../shared/browser-client-page-renderer-protocol'
import { installBrowserClientPageRenderer } from './browser-client-page-renderer-installation'

const PAGE = {
  partition: 'persist:route-a',
  browserPageId: 'page-a',
  pageHostGeneration: 7
}

type RequestCallback = (
  request: BrowserClientPageRendererRequest
) => BrowserClientPageRendererOutcome | Promise<BrowserClientPageRendererOutcome>

describe('browser client page renderer installation', () => {
  afterEach(() => {
    delete (window as unknown as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
  })

  it('stays inert when the preload surface is unavailable', () => {
    expect(installBrowserClientPageRenderer({ subscribe: undefined })).toBeNull()
  })

  it('stays inert in the paired web client', () => {
    ;(window as unknown as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
    const subscribe = vi.fn()

    expect(installBrowserClientPageRenderer({ subscribe })).toBeNull()
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('routes mount, rekey, and idempotent retirement through one subscriber', async () => {
    let callback: RequestCallback | null = null
    const unsubscribe = vi.fn()
    const subscribe = vi.fn((next: typeof callback) => {
      callback = next
      return unsubscribe
    })
    const registry = {
      dispose: vi.fn(),
      getMemoryProfile: vi.fn(() => ({
        retainedPageCount: 1,
        attachingPageCount: 0,
        attachedPageCount: 1,
        retiringPageCount: 0,
        partitionCount: 1
      })),
      mountPage: vi.fn(async () => ({ webContentsId: 41 })),
      rekeyPage: vi.fn(),
      retirePage: vi.fn()
    }
    const installation = installBrowserClientPageRenderer({ registry, subscribe })!

    await expect(
      Promise.resolve(callback!({ requestId: 'mount-a', type: 'mountPage', page: PAGE }))
    ).resolves.toEqual({ type: 'mounted', webContentsId: 41 })
    const nextPage = { ...PAGE, pageHostGeneration: 8 }
    await expect(
      Promise.resolve(callback!({ requestId: 'rekey-a', type: 'rekeyPage', page: PAGE, nextPage }))
    ).resolves.toEqual({ type: 'rekeyed' })
    await expect(
      Promise.resolve(callback!({ requestId: 'retire-a', type: 'retirePage', page: PAGE }))
    ).resolves.toEqual({ type: 'retired' })
    expect(registry.mountPage).toHaveBeenCalledWith(PAGE)
    expect(registry.rekeyPage).toHaveBeenCalledWith(PAGE, nextPage)
    expect(registry.retirePage).toHaveBeenCalledWith(PAGE)
    expect(installation.getMemoryProfile().retainedPageCount).toBe(1)

    installation.dispose()
    installation.dispose()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(registry.dispose).toHaveBeenCalledOnce()
  })

  it('returns only stable renderer failure codes', async () => {
    let callback: RequestCallback | null = null
    const registry = {
      dispose: vi.fn(),
      getMemoryProfile: vi.fn(),
      mountPage: vi.fn(async () => {
        throw new Error('browser_client_page_renderer_attach_timeout')
      }),
      rekeyPage: vi.fn(),
      retirePage: vi.fn(() => {
        throw new Error('sensitive renderer detail')
      })
    }
    installBrowserClientPageRenderer({
      registry,
      subscribe: (next) => {
        callback = next
        return () => {}
      }
    })

    await expect(
      Promise.resolve(callback!({ requestId: 'mount-a', type: 'mountPage', page: PAGE }))
    ).resolves.toEqual({ type: 'failed', errorCode: 'browser_client_page_renderer_attach_timeout' })
    await expect(
      Promise.resolve(callback!({ requestId: 'retire-a', type: 'retirePage', page: PAGE }))
    ).resolves.toEqual({
      type: 'failed',
      errorCode: 'browser_client_page_renderer_operation_failed'
    })
  })
})
