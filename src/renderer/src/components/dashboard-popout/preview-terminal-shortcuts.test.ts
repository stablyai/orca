// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import type { DashboardCardTerminalInput } from '../../../../shared/dashboard-snapshot'
import {
  resolvePreviewShortcutAction,
  type PreviewShortcutContext
} from './preview-terminal-shortcuts'

const LOCAL_MAC: DashboardCardTerminalInput = {
  hostPlatform: 'darwin',
  localWindowsConpty: false,
  windowsShiftEnterEncoding: 'alt-enter',
  ctrlEnterCsiU: false,
  kittyKeyboardAdvertised: true
}

function contextFor(
  overrides: Partial<PreviewShortcutContext> & { kitty?: boolean } = {}
): PreviewShortcutContext {
  return {
    clientPlatform: 'darwin',
    macOptionAsAlt: 'false',
    optionKeyLocation: 0,
    keybindings: undefined,
    terminalInput: LOCAL_MAC,
    kittyKeyboardActive: () => overrides.kitty === true,
    terminalShortcutPolicy: 'orca-first',
    ...overrides
  }
}

function keydown(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', init)
}

describe('resolvePreviewShortcutAction', () => {
  it('kills the previous word on Ctrl+Backspace instead of deleting one character', () => {
    expect(
      resolvePreviewShortcutAction(keydown({ key: 'Backspace', ctrlKey: true }), contextFor())
    ).toEqual({ type: 'sendInput', data: '\x17' })
  })

  it('maps the macOS line-kill and word-navigation chords', () => {
    const context = contextFor()
    expect(
      resolvePreviewShortcutAction(keydown({ key: 'Backspace', metaKey: true }), context)
    ).toEqual({ type: 'sendInput', data: '\x15' })
    expect(
      resolvePreviewShortcutAction(keydown({ key: 'Delete', metaKey: true }), context)
    ).toEqual({ type: 'sendInput', data: '\x0b' })
    expect(
      resolvePreviewShortcutAction(keydown({ key: 'ArrowLeft', altKey: true }), context)
    ).toEqual({ type: 'sendInput', data: '\x1bb' })
    expect(
      resolvePreviewShortcutAction(keydown({ key: 'ArrowUp', metaKey: true }), context)
    ).toEqual({ type: 'scrollViewport', position: 'top' })
  })

  it('leaves Option chords to xterm while the TUI has kitty mode negotiated', () => {
    const kittyContext = contextFor({ kitty: true })
    expect(
      resolvePreviewShortcutAction(keydown({ key: 'Backspace', altKey: true }), kittyContext)
    ).toBeNull()
    expect(
      resolvePreviewShortcutAction(keydown({ key: 'Backspace', altKey: true }), contextFor())
    ).toEqual({ type: 'sendInput', data: '\x1b\x7f' })
  })

  it('withholds the Ctrl+arrow translation on a local ConPTY pty, where PSReadLine binds it', () => {
    const conpty = contextFor({
      clientPlatform: 'win32',
      terminalInput: {
        hostPlatform: 'win32',
        localWindowsConpty: true,
        windowsShiftEnterEncoding: 'alt-enter',
        ctrlEnterCsiU: false,
        kittyKeyboardAdvertised: false
      }
    })
    expect(
      resolvePreviewShortcutAction(keydown({ key: 'ArrowLeft', ctrlKey: true }), conpty)
    ).toBeNull()
    expect(
      resolvePreviewShortcutAction(
        keydown({ key: 'ArrowLeft', ctrlKey: true }),
        contextFor({ clientPlatform: 'linux', terminalInput: null })
      )
    ).toEqual({ type: 'sendInput', data: '\x1bb' })
  })

  it('routes Shift+Enter by the PTY host, not the client OS', () => {
    // A macOS client driving a Windows runtime that negotiated CSI-u.
    const windowsHost = contextFor({
      terminalInput: {
        hostPlatform: 'win32',
        localWindowsConpty: false,
        windowsShiftEnterEncoding: 'csi-u',
        ctrlEnterCsiU: false,
        kittyKeyboardAdvertised: true
      }
    })
    expect(
      resolvePreviewShortcutAction(keydown({ key: 'Enter', shiftKey: true }), windowsHost)
    ).toEqual({ type: 'sendInput', data: '\x1b[13;2u' })
    expect(
      resolvePreviewShortcutAction(keydown({ key: 'Enter', shiftKey: true }), contextFor())
    ).toEqual({ type: 'sendInput', data: '\x1b\r' })
  })

  it('protects local ConPTY shells while preserving trusted Ctrl+Enter consumers', () => {
    const conpty = contextFor({
      clientPlatform: 'win32',
      terminalInput: {
        hostPlatform: 'win32',
        localWindowsConpty: true,
        windowsShiftEnterEncoding: 'alt-enter',
        ctrlEnterCsiU: false,
        kittyKeyboardAdvertised: false
      }
    })
    expect(
      resolvePreviewShortcutAction(keydown({ key: 'Enter', ctrlKey: true }), {
        ...conpty,
        kittyKeyboardActive: () => true
      })
    ).toEqual({ type: 'sendInput', data: '\x1b[13;5u' })
    expect(resolvePreviewShortcutAction(keydown({ key: 'Enter', ctrlKey: true }), conpty)).toEqual({
      type: 'sendInput',
      data: '\r'
    })
    expect(
      resolvePreviewShortcutAction(
        keydown({ key: 'Enter', ctrlKey: true }),
        contextFor({
          clientPlatform: 'win32',
          terminalInput: {
            hostPlatform: 'win32',
            localWindowsConpty: true,
            windowsShiftEnterEncoding: 'alt-enter',
            ctrlEnterCsiU: true,
            kittyKeyboardAdvertised: false
          }
        })
      )
    ).toEqual({ type: 'sendInput', data: '\x1b[13;5u' })
  })

  it('reports pane-scoped chords so the caller can swallow them', () => {
    expect(
      resolvePreviewShortcutAction(keydown({ key: 'd', code: 'KeyD', metaKey: true }), contextFor())
    ).toEqual({ type: 'splitActivePane', direction: 'vertical' })
  })

  // Why: a terminal-first user remapped terminal.closePane away, so only the
  // tab.close alias still matches Ctrl+W — which the shell owns as a word-kill.
  // The pane yields it; the preview must not swallow it.
  it('follows the terminal shortcut policy for the tab.close pane-close alias', () => {
    const keybindings = {
      'terminal.closePane': ['Mod+Shift+W'],
      'tab.close': ['Ctrl+W']
    } as unknown as PreviewShortcutContext['keybindings']
    const chord = (): KeyboardEvent => keydown({ key: 'w', code: 'KeyW', ctrlKey: true })
    expect(
      resolvePreviewShortcutAction(
        chord(),
        contextFor({ clientPlatform: 'linux', terminalInput: null, keybindings })
      )
    ).toEqual({ type: 'closeActivePane' })
    expect(
      resolvePreviewShortcutAction(
        chord(),
        contextFor({
          clientPlatform: 'linux',
          terminalInput: null,
          keybindings,
          terminalShortcutPolicy: 'terminal-first'
        })
      )
    ).toBeNull()
  })

  it('leaves ordinary typing to xterm', () => {
    expect(
      resolvePreviewShortcutAction(keydown({ key: 'a', code: 'KeyA' }), contextFor())
    ).toBeNull()
    expect(resolvePreviewShortcutAction(keydown({ key: 'Backspace' }), contextFor())).toBeNull()
  })
})
