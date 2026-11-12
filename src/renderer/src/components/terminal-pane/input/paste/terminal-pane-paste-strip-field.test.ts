// @vitest-environment happy-dom
// SETUP-PASTE (P0): the cloud setup strip is portaled into the pane container, above the terminal.
// A paste into its "Paste code" field — Cmd+V, the app menu's Paste, a native paste event, or a
// right-click — must stay in the field and never reach the shell.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type React from 'react'
import { APP_MENU_PASTE_EVENT } from '@/lib/clipboard/menu/app-menu-paste'
import { pasteBelongsToPaneControl } from './paste-belongs-to-pane-control'
import { createTerminalRightClickPasteCapture } from './create-terminal-right-click-paste-capture'
import { registerTerminalPanePasteListeners } from './terminal-pane-paste-listeners'

vi.mock('../../../../store/index', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/lib/workspace/ownership/connection-context', () => ({ getConnectionId: () => null }))

let container: HTMLDivElement
let field: HTMLInputElement
let xtermTextarea: HTMLTextAreaElement
let dispose: () => void
const pasteFromClipboard = vi.fn()
const executePanePasteText = vi.fn()

beforeEach(() => {
  container = document.createElement('div')
  const strip = document.createElement('section')
  strip.setAttribute('data-cloud-sign-in-strip', '')
  field = document.createElement('input')
  strip.append(field)
  const xterm = document.createElement('div')
  xtermTextarea = document.createElement('textarea')
  xtermTextarea.className = 'xterm-helper-textarea'
  xterm.append(xtermTextarea)
  container.append(strip, xterm)
  document.body.append(container)
  const pane = { id: 1, terminal: {} }
  dispose = registerTerminalPanePasteListeners({
    container,
    controller: {
      keybindings: {},
      managerRef: { current: { getActivePane: () => pane, getPanes: () => [pane] } },
      paneTransportsRef: { current: new Map() },
      setTerminalError: vi.fn(),
      worktreeId: 'wt'
    } as never,
    execution: {
      createPaneClipboardCopiedFiles: vi.fn(),
      executePanePasteText,
      pasteFromClipboard,
      resolvePaneProtectedMultilinePasteOptions: vi.fn()
    } as never,
    isMac: true,
    shortcutPlatform: 'darwin'
  })
})

afterEach(() => {
  dispose()
  container.remove()
  vi.clearAllMocks()
})

const cmdV = (): KeyboardEvent =>
  new KeyboardEvent('keydown', {
    key: 'v',
    code: 'KeyV',
    metaKey: true,
    bubbles: true,
    cancelable: true
  })

describe('a paste into the cloud strip field never reaches the terminal', () => {
  it('Cmd+V in the field: the terminal does not paste, and the field keeps the native paste', () => {
    field.focus()
    const event = cmdV()
    field.dispatchEvent(event)
    expect(pasteFromClipboard).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('a native paste event in the field is left to the field', () => {
    const event = new Event('paste', { bubbles: true, cancelable: true })
    field.dispatchEvent(event)
    expect(pasteFromClipboard).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it("the app menu's Paste while the field has focus is not sent to the shell", () => {
    field.focus()
    const event = new Event(APP_MENU_PASTE_EVENT, { cancelable: true })
    window.dispatchEvent(event)
    expect(executePanePasteText).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('still pastes into the terminal when the terminal has focus (Cmd+V)', () => {
    xtermTextarea.focus()
    const event = cmdV()
    xtermTextarea.dispatchEvent(event)
    expect(pasteFromClipboard).toHaveBeenCalledTimes(1)
  })

  it('right-click paste on the field is not claimed by the terminal', () => {
    const { onMouseDownCapture } = createTerminalRightClickPasteCapture({
      rightClickToPaste: true,
      findClickedPane: () => ({ terminal: {} }) as never
    })
    const preventDefault = vi.fn()
    onMouseDownCapture({
      button: 2,
      target: field,
      preventDefault,
      stopPropagation: vi.fn()
    } as unknown as React.MouseEvent<HTMLDivElement>)
    expect(preventDefault).not.toHaveBeenCalled()
  })
})

describe('pasteBelongsToPaneControl', () => {
  it('is the field’s for the strip and any non-xterm input; the terminal’s for xterm and plain pane content', () => {
    expect(pasteBelongsToPaneControl(field)).toBe(true)
    expect(pasteBelongsToPaneControl(container.querySelector('[data-cloud-sign-in-strip]'))).toBe(
      true
    )
    expect(pasteBelongsToPaneControl(xtermTextarea)).toBe(false)
    expect(pasteBelongsToPaneControl(xtermTextarea.parentElement)).toBe(false)
  })
})
