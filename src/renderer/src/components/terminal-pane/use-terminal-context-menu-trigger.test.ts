// @vitest-environment happy-dom
//
// Issue #25192 / #24643: with right-click-to-paste on (the Windows default),
// Codex and pi paste once from the forwarded right-button mouse report and
// Orca pasted the clipboard again, so the text landed twice.
import type React from 'react'
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { useTerminalContextMenuTrigger } from './use-terminal-context-menu-trigger'

const writeTerminalClipboardText = vi.fn(async () => {})
const pasteResolvedPane = vi.fn(async () => {})
let selection: string
let mouseTrackingMode: 'none' | 'any'
let paneContainer: HTMLDivElement
let xtermElement: HTMLDivElement

function renderTrigger(rightClickToPaste = true) {
  const pane = {
    id: 1,
    container: paneContainer,
    terminal: {
      getSelection: () => selection,
      clearSelection: vi.fn(),
      element: xtermElement,
      modes: { mouseTrackingMode }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test-only stub; the hook only reads getPanes() and each pane's id/container/terminal selection, element and modes.
  const manager = { getPanes: () => [pane] } as unknown as PaneManager
  return renderHook(() =>
    useTerminalContextMenuTrigger({
      managerRef: { current: manager },
      containerRef: { current: paneContainer },
      contextPaneIdRef: { current: null },
      rightClickToPaste,
      pasteResolvedPane
    })
  ).result
}

function buildRightClick(
  target: HTMLElement,
  modifiers: { shiftKey?: boolean; ctrlKey?: boolean } = {}
): React.MouseEvent<HTMLDivElement> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test-only event; the hook reads only these fields.
  const event = {
    target,
    currentTarget: paneContainer,
    clientX: 0,
    clientY: 0,
    altKey: false,
    shiftKey: modifiers.shiftKey ?? false,
    ctrlKey: modifiers.ctrlKey ?? false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn()
  } as unknown as React.MouseEvent<HTMLDivElement>
  return event
}

function rightClick(
  onContextMenuCapture: (event: React.MouseEvent<HTMLDivElement>) => void,
  modifiers: { shiftKey?: boolean; ctrlKey?: boolean } = {}
): void {
  const target = document.createElement('span')
  xtermElement.appendChild(target)
  onContextMenuCapture(buildRightClick(target, modifiers))
}

describe('useTerminalContextMenuTrigger right-click paste', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    selection = ''
    mouseTrackingMode = 'none'
    paneContainer = document.createElement('div')
    xtermElement = document.createElement('div')
    paneContainer.appendChild(xtermElement)
    document.body.appendChild(paneContainer)
    // Why: pin a non-Mac platform so Shift is the selection-forcing modifier.
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0)')
    Object.assign(window, { api: { ui: { writeTerminalClipboardText } } })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('pastes when the terminal does not track the mouse', () => {
    const result = renderTrigger()
    rightClick(result.current.onContextMenuCapture)
    expect(pasteResolvedPane).toHaveBeenCalledExactlyOnceWith('right-click')
    expect(result.current.open).toBe(false)
  })

  it('leaves the paste to a mouse-tracking TUI and opens no menu', () => {
    mouseTrackingMode = 'any'
    const result = renderTrigger()
    rightClick(result.current.onContextMenuCapture)
    expect(pasteResolvedPane).not.toHaveBeenCalled()
    expect(result.current.open).toBe(false)
  })

  it('still pastes on Shift+right-click, which xterm never reports to a tracking TUI', () => {
    mouseTrackingMode = 'any'
    const result = renderTrigger()
    rightClick(result.current.onContextMenuCapture, { shiftKey: true })
    expect(pasteResolvedPane).toHaveBeenCalledExactlyOnceWith('right-click')
  })

  it('still pastes from the pane title, which xterm never reports to the TUI', () => {
    mouseTrackingMode = 'any'
    const result = renderTrigger()
    const title = document.createElement('div')
    document.body.appendChild(title)
    result.current.onPaneTitleContextMenu(buildRightClick(title), 1)
    expect(pasteResolvedPane).toHaveBeenCalledExactlyOnceWith('right-click')
  })

  it('still copies a selection in a mouse-tracking TUI', () => {
    mouseTrackingMode = 'any'
    selection = 'selected text'
    const result = renderTrigger()
    rightClick(result.current.onContextMenuCapture)
    expect(writeTerminalClipboardText).toHaveBeenCalledWith('selected text')
    expect(pasteResolvedPane).not.toHaveBeenCalled()
  })
})
