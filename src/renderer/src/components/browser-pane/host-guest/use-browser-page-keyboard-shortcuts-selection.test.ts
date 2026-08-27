// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

const { getShortcutPlatformMock, useAppStoreMock, useBrowserPageWebviewShortcutsMock } = vi.hoisted(
  () => ({
    getShortcutPlatformMock: vi.fn(() => 'darwin' as NodeJS.Platform),
    useAppStoreMock: vi.fn(() => undefined),
    useBrowserPageWebviewShortcutsMock: vi.fn()
  })
)

vi.mock('@/hooks/useShortcutLabel', () => ({ getShortcutPlatform: getShortcutPlatformMock }))
vi.mock('@/store', () => ({ useAppStore: useAppStoreMock }))
vi.mock('./use-browser-page-webview-shortcuts', () => ({
  useBrowserPageWebviewShortcuts: useBrowserPageWebviewShortcutsMock
}))

import { useBrowserPageKeyboardShortcuts } from './use-browser-page-keyboard-shortcuts'

const startGrabIntent = vi.fn()

function renderShortcuts(): void {
  renderHook(() =>
    useBrowserPageKeyboardShortcuts({
      browserTabId: 'tab-1',
      isActive: true,
      isActiveRef: { current: true },
      markupIsActive: false,
      webviewRef: { current: null },
      paneZoomLevelRef: { current: 0 },
      setBrowserDefaultZoomLevel: vi.fn(),
      showBrowserZoomFeedback: vi.fn(),
      reloadWebviewOrRecoverGuest: vi.fn(),
      startGrabIntent,
      handleGrabActionShortcut: vi.fn(),
      grabIsInteractive: false
    })
  )
}

/** Chat transcript prose: a plain paragraph, matching none of the editable-host selectors. */
function mountTranscriptProse(): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = '<p id="prose">assistant reply worth copying</p>'
  document.body.appendChild(host)
  return host.querySelector('#prose') as HTMLElement
}

function selectAcross(node: Node): void {
  const range = document.createRange()
  range.selectNodeContents(node)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

function pressGrabShortcut(target: EventTarget): void {
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true, cancelable: true })
  )
}

describe('useBrowserPageKeyboardShortcuts — grab shortcut vs host text selection', () => {
  beforeEach(() => {
    startGrabIntent.mockClear()
    ;(window as unknown as { api: unknown }).api = {
      browser: {
        onGrabModeToggle: vi.fn(() => vi.fn()),
        onGrabActionShortcut: vi.fn(() => vi.fn())
      }
    }
  })

  afterEach(() => {
    window.getSelection()?.removeAllRanges()
    document.body.innerHTML = ''
  })

  // Why: the transcript is plain prose, so isEditableKeyboardTarget cannot exempt it. Without a
  // selection check the pane-active listener eats Cmd+C and arms the picker instead of copying.
  it('yields Cmd+C to a live selection in the host document', () => {
    const prose = mountTranscriptProse()
    renderShortcuts()
    selectAcross(prose)

    pressGrabShortcut(prose)

    expect(startGrabIntent).not.toHaveBeenCalled()
  })

  it('does not swallow the keydown when it yields', () => {
    const prose = mountTranscriptProse()
    renderShortcuts()
    selectAcross(prose)

    const event = new KeyboardEvent('keydown', {
      key: 'c',
      metaKey: true,
      bubbles: true,
      cancelable: true
    })
    prose.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
  })

  // Why: guest selections live in the <webview>'s own document and never reach
  // window.getSelection(), so grabbing a page element must still work as before.
  it('still arms grab when nothing is selected in the host document', () => {
    const prose = mountTranscriptProse()
    renderShortcuts()

    pressGrabShortcut(prose)

    expect(startGrabIntent).toHaveBeenCalledWith('copy')
  })

  it('still arms grab when the selection is collapsed', () => {
    const prose = mountTranscriptProse()
    renderShortcuts()
    const range = document.createRange()
    range.setStart(prose.firstChild as Node, 3)
    range.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)

    pressGrabShortcut(prose)

    expect(startGrabIntent).toHaveBeenCalledWith('copy')
  })
})
