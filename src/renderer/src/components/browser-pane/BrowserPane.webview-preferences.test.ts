import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const BROWSER_PANE_SOURCE = resolve(__dirname, 'BrowserPane.tsx')

function browserPaneSource(): string {
  return readFileSync(BROWSER_PANE_SOURCE, 'utf8')
}

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)

  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)

  return source.slice(startIndex, endIndex)
}

describe('BrowserPane webview preferences', () => {
  it('keeps HTML fullscreen contained inside the browser pane webview', () => {
    const source = browserPaneSource()
    const creationBlock = sourceBetween(
      source,
      "webview = document.createElement('webview')",
      'registerPersistentWebview'
    )

    expect(source).toContain(
      "import { ORCA_BROWSER_GUEST_WEB_PREFERENCES_ATTRIBUTE } from '../../../../shared/browser-guest-web-preferences'"
    )
    expect(creationBlock).toContain(
      "webview.setAttribute('webpreferences', ORCA_BROWSER_GUEST_WEB_PREFERENCES_ATTRIBUTE)"
    )
    expect(creationBlock).not.toContain('disablehtmlfullscreenwindowresize')
  })

  it('uses the runtime-resolved partition before renderer profile mirror fallback', () => {
    const source = browserPaneSource()
    const pagePanePropsBlock = sourceBetween(
      source,
      'renderedBrowserPages.map((page) => (',
      '<BrowserMobileDriverOverlay'
    )

    expect(pagePanePropsBlock).toContain('sessionPartition={browserTab.sessionPartition ?? null}')
    expect(source).toContain(
      'const webviewPartition = sessionPartition ?? sessionProfile?.partition ?? ORCA_BROWSER_PARTITION'
    )
  })

  it('remounts the webview when the stored resolved partition changes', () => {
    const source = browserPaneSource()
    const remountBlock = sourceBetween(
      source,
      "if (webview && webview.getAttribute('partition') !== webviewPartition)",
      "webview.setAttribute('partition', webviewPartition)"
    )

    expect(remountBlock).toContain('destroyPersistentWebview(browserTab.id)')
    expect(remountBlock).toContain('webview = undefined')
  })
})
