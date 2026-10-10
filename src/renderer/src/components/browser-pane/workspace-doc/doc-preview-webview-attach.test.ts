// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { acquireWebviewsDragPassthrough } from '../host-guest/webview-drag-passthrough'
import { webviewRegistry } from '../host-guest/webview-registry'
import { attachDocPreviewWebview } from './doc-preview-webview-attach'

it('restores pointer input when a drag ends after attaching a document preview', () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const append = vi.spyOn(container, 'appendChild')
  append.mockImplementation((node) => {
    expect((node as HTMLElement).style.pointerEvents).toBe('none')
    return Node.prototype.appendChild.call(container, node)
  })
  const release = acquireWebviewsDragPassthrough()
  const attached = attachDocPreviewWebview({
    previewId: 'preview-drag',
    container,
    url: 'orca-preview://grant/index.html',
    ariaLabel: 'HTML preview',
    onLoadStarted: vi.fn(),
    onLoadStopped: vi.fn(),
    onLoadFailed: vi.fn(),
    onNavigated: vi.fn(),
    onTitleUpdated: vi.fn()
  })

  try {
    expect(webviewRegistry.get('preview-drag')).toBe(attached.webview)
    expect(attached.webview.style.pointerEvents).toBe('none')
    release()
    expect(attached.webview.style.pointerEvents).toBe('')
  } finally {
    release()
    attached.detach()
    container.remove()
    append.mockRestore()
  }
  expect(webviewRegistry.has('preview-drag')).toBe(false)
})
