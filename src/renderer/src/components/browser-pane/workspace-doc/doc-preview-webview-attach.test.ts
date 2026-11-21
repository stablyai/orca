// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'

import { attachDocPreviewWebview } from './doc-preview-webview-attach'

afterEach(() => {
  document.body.innerHTML = ''
})

it('shows loading for page documents only, not iframe or in-page navigations', () => {
  const onLoadStarted = vi.fn()
  const { webview, detach } = attachDocPreviewWebview({
    previewId: 'preview-1',
    container: document.body.appendChild(document.createElement('div')),
    url: 'orca-preview://grant/index.html',
    ariaLabel: 'HTML preview',
    onLoadStarted,
    onLoadStopped: vi.fn(),
    onLoadFailed: vi.fn(),
    onNavigated: vi.fn(),
    onTitleUpdated: vi.fn(),
    onViewportMessage: vi.fn()
  })
  const startNavigation = (isMainFrame: boolean, isInPlace: boolean): void => {
    webview.dispatchEvent(
      Object.assign(new Event('did-start-navigation'), { isMainFrame, isInPlace })
    )
  }

  webview.dispatchEvent(new Event('did-start-loading'))
  startNavigation(false, false)
  startNavigation(true, true)
  expect(onLoadStarted).not.toHaveBeenCalled()

  startNavigation(true, false)
  expect(onLoadStarted).toHaveBeenCalledTimes(1)

  detach()
  startNavigation(true, false)
  expect(onLoadStarted).toHaveBeenCalledTimes(1)
})
