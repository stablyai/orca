// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserClientPageRendererIdentity } from '../../../../shared/browser-client-page-renderer-protocol'
import { ORCA_BROWSER_GUEST_WEB_PREFERENCES_ATTRIBUTE } from '../../../../shared/browser-guest-web-preferences'
import { BrowserClientPageRetainedRegistry } from './browser-client-page-retained-registry'

const PAGE: BrowserClientPageRendererIdentity = {
  partition: 'persist:route-a',
  browserPageId: 'page-a',
  pageHostGeneration: 7
}

function createRig(
  options: {
    attachTimeoutMs?: number
    maxPages?: number
    maxPagesPerPartition?: number
  } = {}
) {
  const webviews: Electron.WebviewTag[] = []
  let nextId = 40
  const registry = new BrowserClientPageRetainedRegistry({
    document,
    ...options,
    createWebview: () => {
      const webview = document.createElement('webview') as Electron.WebviewTag
      Object.defineProperty(webview, 'getWebContentsId', {
        configurable: true,
        value: vi.fn(() => {
          if (webview.dataset.attached !== 'true') {
            throw new Error('guest not attached')
          }
          const current = Number(webview.dataset.webContentsId)
          if (Number.isInteger(current) && current > 0) {
            return current
          }
          const webContentsId = ++nextId
          webview.dataset.webContentsId = String(webContentsId)
          return webContentsId
        })
      })
      webviews.push(webview)
      return webview
    }
  })
  return { registry, webviews }
}

function attach(webview: Electron.WebviewTag): void {
  webview.dataset.attached = 'true'
  webview.dispatchEvent(new Event('did-attach'))
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('browser client page retained registry', () => {
  it('rekeys an attached guest without remounting or changing its WebContents', async () => {
    const { registry, webviews } = createRig()
    const mounting = registry.mountPage(PAGE)
    attach(webviews[0]!)
    await expect(mounting).resolves.toEqual({ webContentsId: 41 })
    const next = { ...PAGE, pageHostGeneration: 8 }

    registry.rekeyPage(PAGE, next)

    await expect(registry.mountPage(next)).resolves.toEqual({ webContentsId: 41 })
    expect(webviews).toHaveLength(1)
    expect(() => registry.rekeyPage(PAGE, { ...next, pageHostGeneration: 9 })).toThrow(
      'browser_client_page_renderer_rekey_stale'
    )
  })

  it('mounts only about:blank in a stable document-level host', async () => {
    const { registry, webviews } = createRig()
    const mounted = registry.mountPage(PAGE)
    const webview = webviews[0]!

    expect(webview.getAttribute('src')).toBe('about:blank')
    expect(webview.getAttribute('partition')).toBe(PAGE.partition)
    expect(webview.getAttribute('webpreferences')).toBe(
      ORCA_BROWSER_GUEST_WEB_PREFERENCES_ATTRIBUTE
    )
    expect(webview.hasAttribute('allowpopups')).toBe(false)
    expect(webview.parentElement?.parentElement?.parentElement).toBe(document.body)
    expect(webview.isConnected).toBe(true)

    attach(webview)
    await expect(mounted).resolves.toEqual({ webContentsId: 41 })
  })

  // The guest lives in a fixed-position overlay, never inside its pane, so nothing in the DOM says
  // which row a `<webview>` belongs to unless the host carries the page id. The paired restart e2e
  // binds its marker read to exactly this stamp.
  it('stamps the retained host with the page id it hosts, and keeps it across a rekey', async () => {
    const { registry, webviews } = createRig()
    const mounting = registry.mountPage(PAGE)
    const webview = webviews[0]!

    expect(
      webview.closest('[data-browser-client-page-id]')?.getAttribute('data-browser-client-page-id')
    ).toBe(PAGE.browserPageId)

    attach(webview)
    await expect(mounting).resolves.toEqual({ webContentsId: 41 })
    // The generation moves on every reissue; the page id is what survives, so it is what binds.
    const next = { ...PAGE, pageHostGeneration: 8 }
    registry.rekeyPage(PAGE, next)
    await expect(registry.mountPage(next)).resolves.toEqual({ webContentsId: 41 })

    expect(
      webview.closest('[data-browser-client-page-id]')?.getAttribute('data-browser-client-page-id')
    ).toBe(PAGE.browserPageId)
    expect(webviews).toHaveLength(1)
  })

  it('shares concurrent exact mounts and reuses the attached incarnation', async () => {
    const { registry, webviews } = createRig()
    const first = registry.mountPage(PAGE)
    const duplicate = registry.mountPage(PAGE)

    expect(duplicate).toBe(first)
    expect(webviews).toHaveLength(1)
    attach(webviews[0]!)
    await expect(first).resolves.toEqual({ webContentsId: 41 })
    await expect(registry.mountPage(PAGE)).resolves.toEqual({ webContentsId: 41 })
    expect(webviews).toHaveLength(1)
  })

  it('moves the retained host without reparenting its attached guest', async () => {
    const { registry, webviews } = createRig()
    const mounting = registry.mountPage(PAGE)
    const webview = webviews[0]!
    attach(webview)
    await mounting
    const retainedHost = webview.parentElement
    const retainedRoot = retainedHost?.parentElement
    const viewport = document.createElement('div')
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
      bottom: 260,
      height: 200,
      left: 40,
      right: 340,
      top: 60,
      width: 300,
      x: 40,
      y: 60,
      toJSON: () => ({})
    })
    document.body.appendChild(viewport)

    const attachment = registry.attachPage(
      {
        browserPageId: PAGE.browserPageId,
        pageHostGeneration: PAGE.pageHostGeneration
      },
      viewport
    )

    expect(attachment.webview).toBe(webview)
    expect(webview.parentElement).toBe(retainedHost)
    expect(retainedHost?.parentElement).toBe(retainedRoot)
    expect(retainedHost?.inert).toBe(false)
    expect(retainedHost?.style.cssText).toContain('left: 40px')
    expect(retainedHost?.style.cssText).toContain('width: 300px')
    attachment.detach()
    expect(webview.parentElement).toBe(retainedHost)
    expect(retainedHost?.parentElement).toBe(retainedRoot)
    expect(retainedHost?.inert).toBe(true)
    expect(retainedHost?.style.cssText).toContain('left: -10000px')
    expect(webview.isConnected).toBe(true)
    expect(registry.getMemoryProfile().attachedPageCount).toBe(1)
  })

  it('tracks a pure pane move that fires no resize or scroll event', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    const cancelled = vi.fn()
    vi.stubGlobal('cancelAnimationFrame', cancelled)
    try {
      const { registry, webviews } = createRig()
      const mounting = registry.mountPage(PAGE)
      attach(webviews[0]!)
      await mounting
      const retainedHost = webviews[0]!.parentElement as HTMLDivElement
      const viewport = document.createElement('div')
      const rect = (left: number): DOMRect =>
        ({
          bottom: 260,
          height: 200,
          left,
          right: left + 300,
          top: 60,
          width: 300,
          x: left,
          y: 60,
          toJSON: () => ({})
        }) as DOMRect
      const bounds = vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect(40))
      document.body.appendChild(viewport)
      const attachment = registry.attachPage(
        { browserPageId: PAGE.browserPageId, pageHostGeneration: PAGE.pageHostGeneration },
        viewport
      )
      expect(retainedHost.style.cssText).toContain('left: 40px')

      // Why: dragging a tab across an even split moves the pane without resizing it.
      bounds.mockReturnValue(rect(700))
      frames.splice(0).forEach((callback) => callback(0))
      expect(retainedHost.style.cssText).toContain('left: 700px')
      expect(retainedHost.style.cssText).toContain('width: 300px')

      attachment.detach()
      expect(cancelled).toHaveBeenCalled()
      expect(retainedHost.style.cssText).toContain('left: -10000px')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps metadata revisions monotonic across visible detach and reattach', async () => {
    const { registry, webviews } = createRig()
    const mounting = registry.mountPage(PAGE)
    attach(webviews[0]!)
    await mounting
    const first = registry.attachPage(PAGE, document.createElement('div'))

    expect(first.nextMetadataRevision()).toBe(1)
    expect(first.nextMetadataRevision()).toBe(2)
    first.detach()
    const second = registry.attachPage(PAGE, document.createElement('div'))

    expect(second.nextMetadataRevision()).toBe(3)
  })

  it('never resurrects a visible guest retired by exact generation', async () => {
    const { registry, webviews } = createRig()
    const mounting = registry.mountPage(PAGE)
    const webview = webviews[0]!
    attach(webview)
    await mounting
    const viewport = document.createElement('div')
    document.body.appendChild(viewport)
    const attachment = registry.attachPage(
      {
        browserPageId: PAGE.browserPageId,
        pageHostGeneration: PAGE.pageHostGeneration
      },
      viewport
    )

    registry.retirePage(PAGE)
    attachment.detach()

    expect(webview.isConnected).toBe(false)
    expect(registry.getMemoryProfile().retiringPageCount).toBe(1)
  })

  it('does not readvertise a cached guest id after the guest becomes unreadable', async () => {
    const { registry, webviews } = createRig()
    const mounting = registry.mountPage(PAGE)
    const webview = webviews[0]!
    attach(webview)
    await mounting
    webview.dataset.attached = 'false'

    await expect(registry.mountPage(PAGE)).rejects.toThrow(
      'browser_client_page_renderer_process_gone'
    )
    expect(registry.getMemoryProfile().retiringPageCount).toBe(1)
    webview.dispatchEvent(new Event('destroyed'))
    expect(registry.getMemoryProfile().retainedPageCount).toBe(0)
  })

  it('waits for dom-ready when the guest id is unavailable at did-attach', async () => {
    const { registry, webviews } = createRig()
    const mounting = registry.mountPage(PAGE)
    const webview = webviews[0]!

    webview.dispatchEvent(new Event('did-attach'))
    expect(registry.getMemoryProfile().attachingPageCount).toBe(1)
    webview.dataset.attached = 'true'
    webview.dispatchEvent(new Event('dom-ready'))

    await expect(mounting).resolves.toEqual({ webContentsId: 41 })
  })

  it('times out after did-attach when the guest id never becomes readable', async () => {
    vi.useFakeTimers()
    const { registry, webviews } = createRig({ attachTimeoutMs: 50 })
    const mounting = registry.mountPage(PAGE)
    const rejected = vi.fn()
    void mounting.catch(rejected)

    webviews[0]!.dispatchEvent(new Event('did-attach'))
    await vi.advanceTimersByTimeAsync(50)

    expect(rejected).toHaveBeenCalledWith(new Error('browser_client_page_renderer_attach_timeout'))
    expect(registry.getMemoryProfile().retiringPageCount).toBe(1)
    webviews[0]!.dispatchEvent(new Event('destroyed'))
    expect(registry.getMemoryProfile().retainedPageCount).toBe(0)
  })

  it('bounds global and per-partition retained pages', async () => {
    const { registry, webviews } = createRig({ maxPages: 2, maxPagesPerPartition: 1 })
    const first = registry.mountPage(PAGE)
    await expect(
      registry.mountPage({ ...PAGE, browserPageId: 'page-b', pageHostGeneration: 8 })
    ).rejects.toThrow('browser_client_page_renderer_partition_capacity')
    const otherPartition = registry.mountPage({
      ...PAGE,
      partition: 'persist:route-b',
      browserPageId: 'page-b'
    })
    await expect(
      registry.mountPage({
        ...PAGE,
        partition: 'persist:route-c',
        browserPageId: 'page-c'
      })
    ).rejects.toThrow('browser_client_page_renderer_capacity')

    attach(webviews[0]!)
    attach(webviews[1]!)
    await Promise.all([first, otherPartition])
    expect(registry.getMemoryProfile()).toEqual({
      retainedPageCount: 2,
      attachingPageCount: 0,
      attachedPageCount: 2,
      retiringPageCount: 0,
      partitionCount: 2
    })
  })

  it('keeps identical page ids isolated across partitions', async () => {
    const { registry, webviews } = createRig()
    const first = registry.mountPage(PAGE)
    const second = registry.mountPage({ ...PAGE, partition: 'persist:route-b' })
    attach(webviews[0]!)
    attach(webviews[1]!)

    await expect(first).resolves.toEqual({ webContentsId: 41 })
    await expect(second).resolves.toEqual({ webContentsId: 42 })
  })

  it('retires a pending attachment immediately and ignores its late event', async () => {
    const { registry, webviews } = createRig()
    const mounting = registry.mountPage(PAGE)
    const webview = webviews[0]!

    registry.retirePage(PAGE)
    await expect(mounting).rejects.toThrow('browser_client_page_renderer_page_retired')
    expect(webview.isConnected).toBe(false)
    expect(registry.getMemoryProfile().retainedPageCount).toBe(0)
    attach(webview)
    expect(registry.getMemoryProfile().retainedPageCount).toBe(0)
  })

  it('holds an observed attachment with an unreadable guest id until destruction', async () => {
    const { registry, webviews } = createRig()
    const mounting = registry.mountPage(PAGE)
    const webview = webviews[0]!

    webview.dispatchEvent(new Event('did-attach'))
    registry.retirePage(PAGE)

    await expect(mounting).rejects.toThrow('browser_client_page_renderer_page_retired')
    expect(registry.getMemoryProfile().retiringPageCount).toBe(1)
    webview.dispatchEvent(new Event('destroyed'))
    expect(registry.getMemoryProfile().retainedPageCount).toBe(0)
  })

  it('rejects when Electron destroys a denied guest before attachment', async () => {
    const { registry, webviews } = createRig()
    const mounting = registry.mountPage(PAGE)

    webviews[0]!.dispatchEvent(new Event('destroyed'))

    await expect(mounting).rejects.toThrow('browser_client_page_renderer_guest_destroyed')
    expect(registry.getMemoryProfile().retainedPageCount).toBe(0)
  })

  it('holds an attached generation until destruction and ignores wrong-generation retirement', async () => {
    const { registry, webviews } = createRig()
    const mounting = registry.mountPage(PAGE)
    const webview = webviews[0]!
    attach(webview)
    await mounting

    registry.retirePage({ ...PAGE, pageHostGeneration: 8 })
    expect(webview.isConnected).toBe(true)
    registry.retirePage(PAGE)
    expect(webview.isConnected).toBe(false)
    expect(registry.getMemoryProfile().retiringPageCount).toBe(1)
    await expect(registry.mountPage(PAGE)).rejects.toThrow(
      'browser_client_page_renderer_page_retiring'
    )

    webview.dispatchEvent(new Event('destroyed'))
    expect(registry.getMemoryProfile().retainedPageCount).toBe(0)
  })

  it('fences renderer-process loss until exact destruction', async () => {
    const { registry, webviews } = createRig()
    const mounting = registry.mountPage(PAGE)
    const webview = webviews[0]!
    attach(webview)
    await mounting

    webview.dispatchEvent(new Event('render-process-gone'))
    expect(webview.isConnected).toBe(false)
    await expect(registry.mountPage(PAGE)).rejects.toThrow(
      'browser_client_page_renderer_page_retiring'
    )
    webview.dispatchEvent(new Event('destroyed'))
    expect(registry.getMemoryProfile().retainedPageCount).toBe(0)
  })

  it('times out a denied attachment and cleans its never-attached host', async () => {
    vi.useFakeTimers()
    const { registry, webviews } = createRig({ attachTimeoutMs: 50 })
    const mounting = registry.mountPage(PAGE)
    const rejection = expect(mounting).rejects.toThrow(
      'browser_client_page_renderer_attach_timeout'
    )

    await vi.advanceTimersByTimeAsync(50)
    await rejection
    expect(webviews[0]?.isConnected).toBe(false)
    expect(registry.getMemoryProfile().retainedPageCount).toBe(0)
  })

  it('treats retirement of an absent exact page as idempotent', () => {
    const { registry } = createRig()
    expect(() => registry.retirePage(PAGE)).not.toThrow()
  })
})
