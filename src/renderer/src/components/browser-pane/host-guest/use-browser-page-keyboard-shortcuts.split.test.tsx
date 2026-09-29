// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type {
  BrowserHistoryNavigateCommand,
  BrowserPageCommandTarget
} from '../../../../../shared/browser-page-command-target'
import type { BrowserPageZoomCommand } from '../../../../../shared/browser-page-zoom'
import { paneChannel } from '../client-hosted-browser-pane-test-rig'
import type { BrowserChromeShortcutScope, GrabIntent } from '../describe-page/browser-page-types'
import { useBrowserPageKeyboardShortcuts } from './use-browser-page-keyboard-shortcuts'

// Why: the chords are Cmd on macOS and Ctrl elsewhere, so the platform cannot be left to the runner.
const MAC_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'

type FakeWebview = {
  goBack: ReturnType<typeof vi.fn>
  goForward: ReturnType<typeof vi.fn>
  getZoomLevel: () => number
  setZoomLevel: ReturnType<typeof vi.fn>
}

type PaneSpies = {
  webview: FakeWebview
  reload: Mock<(ignoreCache: boolean) => void>
  startGrabIntent: Mock<(intent: GrabIntent) => void>
}

let historyNavigate = paneChannel<BrowserHistoryNavigateCommand>()
let reloadRequests = paneChannel<BrowserPageCommandTarget>()
let hardReloadRequests = paneChannel<BrowserPageCommandTarget>()
let zoomRequests = paneChannel<BrowserPageZoomCommand>()

function createSpies(): PaneSpies {
  return {
    webview: {
      goBack: vi.fn(),
      goForward: vi.fn(),
      getZoomLevel: () => 0,
      setZoomLevel: vi.fn()
    },
    reload: vi.fn(),
    startGrabIntent: vi.fn()
  }
}

function PaneHarness({
  id,
  scope,
  spies
}: {
  id: 'a' | 'b' | 'floating'
  scope: BrowserChromeShortcutScope
  spies: PaneSpies
}): React.JSX.Element {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook only calls the history and zoom members the fake provides.
  const webviewRef = useRef(spies.webview as unknown as Electron.WebviewTag)
  const isActiveRef = useRef(true)
  const paneZoomLevelRef = useRef(0)
  useBrowserPageKeyboardShortcuts({
    browserTabId: `page-${id}`,
    workspaceId: `workspace-${id}`,
    isActive: true,
    chromeShortcutScope: scope,
    isActiveRef,
    markupIsActive: false,
    webviewRef,
    paneZoomLevelRef,
    setBrowserDefaultZoomLevel: vi.fn(),
    showBrowserZoomFeedback: vi.fn(),
    reloadWebviewOrRecoverGuest: spies.reload,
    startGrabIntent: spies.startGrabIntent,
    handleGrabActionShortcut: vi.fn(),
    grabIsInteractive: false
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
  const split = createSpies()
  const floating = createSpies()
  render(
    <>
      <PaneHarness id="a" scope="focused" spies={split} />
      <div data-floating-terminal-panel>
        <PaneHarness id="floating" scope="owned-target" spies={floating} />
      </div>
    </>
  )
  return { split, floating }
}

function renderSplit(scopeA: BrowserChromeShortcutScope, scopeB: BrowserChromeShortcutScope) {
  const a = createSpies()
  const b = createSpies()
  render(
    <>
      <PaneHarness id="a" scope={scopeA} spies={a} />
      <PaneHarness id="b" scope={scopeB} spies={b} />
      <p data-testid="transcript">a chat transcript line</p>
    </>
  )
  return { a, b }
}

function byTestId(testId: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
  if (!element) {
    throw new Error(`missing ${testId}`)
  }
  return element
}

function press(target: EventTarget, init: KeyboardEventInit): void {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { metaKey: true, bubbles: true, cancelable: true, ...init })
    )
  })
}

function selectText(testId: string): void {
  const range = document.createRange()
  range.selectNodeContents(byTestId(testId))
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

beforeEach(() => {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: MAC_USER_AGENT })
  historyNavigate = paneChannel()
  reloadRequests = paneChannel()
  hardReloadRequests = paneChannel()
  zoomRequests = paneChannel()
  const inert = (): (() => void) => () => {}
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      browser: { onGrabModeToggle: inert, onGrabActionShortcut: inert },
      ui: {
        onBrowserHistoryNavigate: historyNavigate.subscribe,
        onReloadBrowserPage: reloadRequests.subscribe,
        onHardReloadBrowserPage: hardReloadRequests.subscribe,
        onZoomBrowserPage: zoomRequests.subscribe
      }
    }
  })
})

afterEach(() => {
  window.getSelection()?.removeAllRanges()
  cleanup()
})

describe('useBrowserPageKeyboardShortcuts in a split of two active browser panes', () => {
  it('acts only in the pane whose guest forwarded the chord', () => {
    const { a, b } = renderSplit('focused', 'inactive')

    act(() => historyNavigate.emit({ browserPageId: 'page-b', direction: 'back' }))
    act(() => historyNavigate.emit({ browserPageId: 'page-b', direction: 'forward' }))
    act(() => reloadRequests.emit({ browserPageId: 'page-b' }))
    act(() => hardReloadRequests.emit({ browserPageId: 'page-b' }))
    act(() => zoomRequests.emit({ browserPageId: 'page-b', direction: 'in' }))

    expect(b.webview.goBack).toHaveBeenCalledTimes(1)
    expect(b.webview.goForward).toHaveBeenCalledTimes(1)
    expect(b.reload.mock.calls).toEqual([[false], [true]])
    expect(b.webview.setZoomLevel).toHaveBeenCalledTimes(1)
    expect(a.webview.goBack).not.toHaveBeenCalled()
    expect(a.webview.goForward).not.toHaveBeenCalled()
    expect(a.reload).not.toHaveBeenCalled()
    expect(a.webview.setZoomLevel).not.toHaveBeenCalled()
  })

  it('answers a chrome chord only in the focused split', () => {
    const { a, b } = renderSplit('focused', 'inactive')

    press(window, { key: '[', code: 'BracketLeft' })
    press(window, { key: 'r', code: 'KeyR' })

    expect(a.webview.goBack).toHaveBeenCalledTimes(1)
    expect(a.reload).toHaveBeenCalledWith(false)
    expect(b.webview.goBack).not.toHaveBeenCalled()
    expect(b.reload).not.toHaveBeenCalled()
  })

  it('answers a chrome chord only in the pane it came from when no split is focused', () => {
    const { a, b } = renderSplit('owned-target', 'owned-target')

    press(byTestId('toolbar-b'), { key: '[', code: 'BracketLeft' })
    press(byTestId('toolbar-b'), { key: 'r', code: 'KeyR' })

    expect(b.webview.goBack).toHaveBeenCalledTimes(1)
    expect(b.reload).toHaveBeenCalledTimes(1)
    expect(a.webview.goBack).not.toHaveBeenCalled()
    expect(a.reload).not.toHaveBeenCalled()
  })

  it('arms grab from the focused pane only', () => {
    const { a, b } = renderSplit('focused', 'inactive')

    press(document.body, { key: 'c', code: 'KeyC' })

    expect(a.startGrabIntent).toHaveBeenCalledWith('copy')
    expect(b.startGrabIntent).not.toHaveBeenCalled()
  })

  it('leaves Cmd+C to copy while text is selected', () => {
    const { a, b } = renderSplit('focused', 'inactive')
    selectText('transcript')

    press(document.body, { key: 'c', code: 'KeyC' })

    expect(a.startGrabIntent).not.toHaveBeenCalled()
    expect(b.startGrabIntent).not.toHaveBeenCalled()
  })

  it('answers a floating browser chord only in the floating panel', () => {
    const { split, floating } = renderFloatingOverSplit()

    press(byTestId('toolbar-floating'), { key: '[', code: 'BracketLeft' })
    press(byTestId('toolbar-floating'), { key: 'r', code: 'KeyR' })
    press(byTestId('toolbar-floating'), { key: 'c', code: 'KeyC' })

    expect(floating.webview.goBack).toHaveBeenCalledTimes(1)
    expect(floating.reload).toHaveBeenCalledWith(false)
    expect(floating.startGrabIntent).toHaveBeenCalledWith('copy')
    expect(split.webview.goBack).not.toHaveBeenCalled()
    expect(split.reload).not.toHaveBeenCalled()
    expect(split.startGrabIntent).not.toHaveBeenCalled()
  })

  it('leaves the floating browser alone for a chord aimed at the focused split', () => {
    const { split, floating } = renderFloatingOverSplit()

    press(byTestId('toolbar-a'), { key: '[', code: 'BracketLeft' })
    press(byTestId('toolbar-a'), { key: 'r', code: 'KeyR' })
    press(byTestId('toolbar-a'), { key: 'c', code: 'KeyC' })

    expect(split.webview.goBack).toHaveBeenCalledTimes(1)
    expect(split.reload).toHaveBeenCalledWith(false)
    expect(split.startGrabIntent).toHaveBeenCalledWith('copy')
    expect(floating.webview.goBack).not.toHaveBeenCalled()
    expect(floating.reload).not.toHaveBeenCalled()
    expect(floating.startGrabIntent).not.toHaveBeenCalled()
  })
})
