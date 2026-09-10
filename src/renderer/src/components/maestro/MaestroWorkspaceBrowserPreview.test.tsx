// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { callRuntimeRpc } = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  callRuntimeRpc
}))

import { MaestroWorkspaceBrowserPreview } from './MaestroWorkspaceBrowserPreview'

const SCREENSHOT = { format: 'png', data: 'abc123' }

function previewImage(): Element | null {
  return document.querySelector('[data-browser-page-id="page-1"]')
}

function callsFor(method: string): unknown[][] {
  return callRuntimeRpc.mock.calls.filter((call) => call[1] === method)
}

describe('MaestroWorkspaceBrowserPreview', () => {
  afterEach(cleanup)
  beforeEach(() => {
    callRuntimeRpc.mockReset().mockImplementation((_target, method) => {
      if (method === 'browser.screenshot') {
        return Promise.resolve(SCREENSHOT)
      }
      if (method === 'browser.tabShow') {
        return Promise.resolve({
          tab: { browserPageId: 'page-1', url: 'https://example.test', title: 'Example' }
        })
      }
      return Promise.resolve({
        url: 'https://example.test',
        title: 'Example'
      })
    })
  })

  it('captures the exact page through the browser screenshot authority', async () => {
    render(
      <MaestroWorkspaceBrowserPreview
        target={{ kind: 'local' }}
        pageId="page-1"
        browserWorkspaceId="workspace-1"
        receiptRevision={1}
      />
    )
    await vi.waitFor(() => expect(previewImage()).not.toBeNull())
    expect(callsFor('browser.screenshot')).toHaveLength(1)
    expect(callsFor('browser.screenshot')[0]?.[2]).toEqual({
      page: 'page-1',
      format: 'png'
    })
    expect(callsFor('browser.tabShow')[0]?.[2]).toEqual({ page: 'page-1' })
  })

  it('keeps the resolved capture when a layout mutation rebuilds equivalent props', async () => {
    const view = render(
      <MaestroWorkspaceBrowserPreview
        target={{ kind: 'local' }}
        pageId="page-1"
        browserWorkspaceId="workspace-1"
        receiptRevision={1}
      />
    )
    await vi.waitFor(() => expect(previewImage()).not.toBeNull())
    callRuntimeRpc.mockClear()
    view.rerender(
      <MaestroWorkspaceBrowserPreview
        target={{ kind: 'local' }}
        pageId="page-1"
        browserWorkspaceId="workspace-1"
        receiptRevision={1}
      />
    )
    expect(previewImage()).not.toBeNull()
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('captures again only when the receipt revision changes after resolution', async () => {
    const view = render(
      <MaestroWorkspaceBrowserPreview
        target={{ kind: 'local' }}
        pageId="page-1"
        browserWorkspaceId="workspace-1"
        receiptRevision={1}
      />
    )
    await vi.waitFor(() => expect(previewImage()).not.toBeNull())
    view.rerender(
      <MaestroWorkspaceBrowserPreview
        target={{ kind: 'local' }}
        pageId="page-1"
        browserWorkspaceId="workspace-1"
        receiptRevision={2}
      />
    )
    await vi.waitFor(() => expect(callsFor('browser.screenshot')).toHaveLength(2))
    await vi.waitFor(() => expect(previewImage()).not.toBeNull())
  })

  it('keeps the previous image in place while a revision recapture is pending', async () => {
    let resolveSecondCapture!: (value: typeof SCREENSHOT) => void
    let screenshotCalls = 0
    callRuntimeRpc.mockImplementation((_target, method) => {
      if (method !== 'browser.screenshot') {
        return Promise.resolve({
          tab: { browserPageId: 'page-1', url: 'https://example.test', title: 'Example' }
        })
      }
      screenshotCalls += 1
      if (screenshotCalls === 1) {
        return Promise.resolve(SCREENSHOT)
      }
      return new Promise((resolve) => {
        resolveSecondCapture = resolve
      })
    })
    const view = render(
      <MaestroWorkspaceBrowserPreview
        target={{ kind: 'local' }}
        pageId="page-1"
        browserWorkspaceId="workspace-1"
        receiptRevision={1}
      />
    )
    await vi.waitFor(() => expect(previewImage()).not.toBeNull())
    expect(previewImage()?.getAttribute('src')).toBe('data:image/png;base64,abc123')
    view.rerender(
      <MaestroWorkspaceBrowserPreview
        target={{ kind: 'local' }}
        pageId="page-1"
        browserWorkspaceId="workspace-1"
        receiptRevision={2}
      />
    )
    expect(callsFor('browser.screenshot')).toHaveLength(2)
    // The stale-but-valid frame stays mounted until the newer capture resolves.
    expect(previewImage()).not.toBeNull()
    expect(previewImage()?.getAttribute('src')).toBe('data:image/png;base64,abc123')
    act(() => resolveSecondCapture({ format: 'png', data: 'def456' }))
    await vi.waitFor(() =>
      expect(previewImage()?.getAttribute('src')).toBe('data:image/png;base64,def456')
    )
  })

  it('forwards pointer input to the same Browser page without focusing its exact tab', async () => {
    const onInteract = vi.fn()
    render(
      <MaestroWorkspaceBrowserPreview
        target={{ kind: 'local' }}
        pageId="page-1"
        browserWorkspaceId="workspace-1"
        receiptRevision={1}
        selected
        onInteract={onInteract}
      />
    )
    await vi.waitFor(() => expect(previewImage()).not.toBeNull())
    callRuntimeRpc.mockClear()
    const image = previewImage() as HTMLImageElement
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 800 },
      naturalHeight: { configurable: true, value: 400 }
    })
    image.getBoundingClientRect = () => ({ left: 10, top: 20, width: 400, height: 200 }) as DOMRect

    fireEvent.pointerDown(image, { button: 0, clientX: 210, clientY: 120 })

    await vi.waitFor(() => expect(callRuntimeRpc).toHaveBeenCalledTimes(2))
    expect(callRuntimeRpc).toHaveBeenNthCalledWith(
      1,
      { kind: 'local' },
      'browser.mouseMove',
      { page: 'page-1', x: 400, y: 200 },
      { timeoutMs: 15_000, suppressFeatureInteraction: true }
    )
    expect(callRuntimeRpc).toHaveBeenNthCalledWith(
      2,
      { kind: 'local' },
      'browser.mouseDown',
      { page: 'page-1', button: 'left' },
      { timeoutMs: 15_000, suppressFeatureInteraction: true }
    )
    expect(onInteract).toHaveBeenCalledOnce()
    expect(callRuntimeRpc.mock.calls.some((call) => call[1] === 'browser.tabSwitch')).toBe(false)
  })

  it('drives exact-page navigation while sanitizing addresses and runtime failures', async () => {
    callRuntimeRpc.mockImplementation((_target, method) => {
      if (method === 'browser.screenshot') {
        return Promise.resolve(SCREENSHOT)
      }
      if (method === 'browser.tabShow') {
        return Promise.resolve({
          tab: {
            browserPageId: 'page-1',
            url: 'https://kagi.com/search?token=private&q=orca',
            title: 'Search'
          }
        })
      }
      if (method === 'browser.reload') {
        return Promise.reject(new Error('rpc secret: bearer-token'))
      }
      return Promise.resolve({ url: 'https://example.test/next', title: 'Next' })
    })
    render(
      <MaestroWorkspaceBrowserPreview
        target={{ kind: 'local' }}
        pageId="page-1"
        browserWorkspaceId="workspace-1"
        receiptRevision={1}
        selected
      />
    )

    const address = await screen.findByRole<HTMLInputElement>('textbox', {
      name: 'Browser address'
    })
    await vi.waitFor(() => expect(address.disabled).toBe(false))
    expect(address.value).toBe('https://kagi.com/search?q=orca')

    fireEvent.change(address, { target: { value: 'example.test/next' } })
    fireEvent.submit(address.closest('form') as HTMLFormElement)
    await vi.waitFor(() => expect(callsFor('browser.goto')).toHaveLength(1))
    expect(callsFor('browser.goto')[0]?.[2]).toEqual({
      page: 'page-1',
      url: 'https://example.test/next'
    })

    await vi.waitFor(() =>
      expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(
        false
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await vi.waitFor(() => expect(callsFor('browser.back')).toHaveLength(1))
    await vi.waitFor(() =>
      expect((screen.getByRole('button', { name: 'Forward' }) as HTMLButtonElement).disabled).toBe(
        false
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }))
    await vi.waitFor(() => expect(callsFor('browser.forward')).toHaveLength(1))
    await vi.waitFor(() =>
      expect((screen.getByRole('button', { name: 'Reload' }) as HTMLButtonElement).disabled).toBe(
        false
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    await vi.waitFor(() =>
      expect(screen.getByText(/Browser controls are temporarily unavailable/)).not.toBeNull()
    )
    expect(screen.queryByText(/bearer-token/)).toBeNull()
  })
})
