// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import type { Dispatch, SetStateAction } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserChromeShortcutScope } from '../describe-page/browser-page-types'
import { useBrowserPageFindShortcuts } from './use-browser-page-find-shortcuts'

// Why: Find is Cmd+F on macOS and Ctrl+F elsewhere, so the platform cannot be left to the runner.
const MAC_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'

function FindHarness({
  id,
  scope,
  setFindOpen
}: {
  id: string
  scope: BrowserChromeShortcutScope
  setFindOpen: Dispatch<SetStateAction<boolean>>
}): React.JSX.Element {
  useBrowserPageFindShortcuts({
    browserTabId: `page-${id}`,
    workspaceId: `workspace-${id}`,
    isActive: true,
    chromeShortcutScope: scope,
    setFindOpen
  })
  return (
    <div data-browser-overlay-tab-id={`workspace-${id}`}>
      <button type="button" data-testid={`toolbar-${id}`}>
        toolbar
      </button>
    </div>
  )
}

function renderFloatingOverSplit() {
  const split = vi.fn()
  const floating = vi.fn()
  render(
    <>
      <FindHarness id="a" scope="focused" setFindOpen={split} />
      <div data-floating-terminal-panel>
        <FindHarness id="floating" scope="owned-target" setFindOpen={floating} />
      </div>
    </>
  )
  return { split, floating }
}

function pressFind(testId: string): void {
  const target = document.querySelector(`[data-testid="${testId}"]`)
  act(() => {
    target?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true })
    )
  })
}

beforeEach(() => {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: MAC_USER_AGENT })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ui: { onFindInBrowserPage: () => () => {} } }
  })
})

afterEach(() => {
  cleanup()
})

describe('useBrowserPageFindShortcuts with a floating browser over a focused split', () => {
  it('opens find only in the floating browser for a chord from its chrome', () => {
    const { split, floating } = renderFloatingOverSplit()

    pressFind('toolbar-floating')

    expect(floating).toHaveBeenCalledWith(true)
    expect(split).not.toHaveBeenCalled()
  })

  it('opens find only in the focused split for a chord from its chrome', () => {
    const { split, floating } = renderFloatingOverSplit()

    pressFind('toolbar-a')

    expect(split).toHaveBeenCalledWith(true)
    expect(floating).not.toHaveBeenCalled()
  })
})
