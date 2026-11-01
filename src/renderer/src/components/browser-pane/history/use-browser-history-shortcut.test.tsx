// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { BrowserChromeShortcutScope } from '../describe-page/browser-page-types'
import { useBrowserHistoryShortcut } from './use-browser-history-shortcut'

function Pane({
  pageId,
  workspaceId,
  chromeShortcutScope
}: {
  pageId: string
  workspaceId: string
  chromeShortcutScope: BrowserChromeShortcutScope
}): null {
  useBrowserHistoryShortcut({
    browserTabId: pageId,
    workspaceId,
    isActive: true,
    chromeShortcutScope
  })
  return null
}

function pressShowHistory(target: Element): void {
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'y', code: 'KeyY', metaKey: true, bubbles: true })
  )
}

describe('useBrowserHistoryShortcut', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ui: { onShowBrowserHistory: () => () => {} } }
    })
    useAppStore.setState({ browserHistoryPageId: null })
  })

  afterEach(() => {
    cleanup()
    document.body.replaceChildren()
  })

  it('keeps a floating browser history open on its own page when the shortcut repeats', () => {
    render(
      <>
        <Pane pageId="main-page" workspaceId="main-ws" chromeShortcutScope="focused" />
        <Pane pageId="floating-page" workspaceId="floating-ws" chromeShortcutScope="owned-target" />
      </>
    )
    const floatingPanel = document.createElement('div')
    floatingPanel.setAttribute('data-floating-terminal-panel', '')
    const floatingChrome = document.createElement('div')
    floatingChrome.setAttribute('data-browser-overlay-tab-id', 'floating-ws')
    floatingPanel.append(floatingChrome)
    // The dialog portals its search field to the body, outside both panes.
    const dialogSearch = document.createElement('input')
    document.body.append(floatingPanel, dialogSearch)

    act(() => pressShowHistory(floatingChrome))
    expect(useAppStore.getState().browserHistoryPageId).toBe('floating-page')

    act(() => pressShowHistory(dialogSearch))
    expect(useAppStore.getState().browserHistoryPageId).toBe('floating-page')
  })
})
