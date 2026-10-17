// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { dispatchTerminalShortcutAction } from './terminal-keyboard-action-dispatch'
import { resolveTerminalShortcutAction } from './terminal-shortcut-policy'
import { createTerminalNativeOnlyShortcutTracker } from './terminal-native-only-shortcut'

type DispatchContext = Parameters<typeof dispatchTerminalShortcutAction>[3]

/** Runs the real dispatcher to observe native focus and shortcut press/release ownership. */
function dispatchCopy(
  selection: string,
  repeat: boolean,
  platform?: { platform: NodeJS.Platform; displayServer: 'wayland' | 'x11' | null }
) {
  const writeTerminalClipboardText = vi.fn().mockResolvedValue(undefined)
  const textarea = document.createElement('textarea')
  document.body.appendChild(textarea)
  const terminalFocus = vi.fn(() => textarea.focus())
  const clearSelection = vi.fn()
  let nativeCopyTarget: Element | null = null
  const performNativeSelectionAction = vi.fn(() => {
    nativeCopyTarget = document.activeElement
    return Promise.resolve(true)
  })
  vi.stubGlobal('api', {
    ui: { writeTerminalClipboardText, performNativeSelectionAction },
    platform: platform ? { get: () => platform } : undefined
  })
  const tracker = createTerminalNativeOnlyShortcutTracker()
  const event = new KeyboardEvent('keydown', {
    key: 'c',
    code: 'KeyC',
    metaKey: true,
    repeat,
    cancelable: true
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Copy only reads the stubbed active terminal's selection and focuses it.
  const manager = {
    getActivePane: () => ({
      terminal: { getSelection: () => selection, focus: terminalFocus, clearSelection }
    })
  } as unknown as PaneManager
  const context: DispatchContext = {
    tabId: 'tab',
    worktreeId: 'workspace',
    fallbackCwd: '',
    expandedPaneIdRef: { current: null },
    setExpandedPane: vi.fn(),
    restoreExpandedLayout: vi.fn(),
    refreshPaneSizes: vi.fn(),
    persistLayoutSnapshot: vi.fn(),
    toggleExpandPane: vi.fn(),
    setSearchOpen: vi.fn(),
    focusSearchInput: vi.fn(),
    searchOpenRef: { current: false },
    onRequestClosePane: vi.fn(),
    onClearPaneScrollback: vi.fn(),
    onSetTitle: vi.fn(),
    onClearPaneTitle: vi.fn(),
    paneTransportsRef: { current: new Map() },
    paneCwdRef: { current: new Map() },
    managerRef: { current: manager },
    getKeyboardSplitTelemetrySource: () => 'keyboard',
    armNativeOnlyShortcut: tracker.armKeyDown
  }
  dispatchTerminalShortcutAction({ type: 'copySelection' }, event, manager, context)
  expect(clearSelection).not.toHaveBeenCalled()
  if (performNativeSelectionAction.mock.calls.length === 0) {
    expect(terminalFocus).not.toHaveBeenCalled()
  } else {
    expect(terminalFocus).toHaveBeenCalledOnce()
    expect(nativeCopyTarget).toBe(textarea)
  }
  return {
    claimed: event.defaultPrevented,
    copies: writeTerminalClipboardText.mock.calls.length,
    nativeCopies: performNativeSelectionAction.mock.calls,
    releaseClaimed: tracker.consumeCompanion({ type: 'keyup', key: 'c', code: 'KeyC' })
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('terminal copy shortcut', () => {
  it('leaves an unselected press to the terminal', () => {
    expect(dispatchCopy('', false)).toEqual({
      claimed: false,
      copies: 0,
      nativeCopies: [],
      releaseClaimed: false
    })
  })

  it('copies a selection once and claims the press through its release', () => {
    expect(dispatchCopy('text', false)).toEqual({
      claimed: true,
      copies: 1,
      nativeCopies: [],
      releaseClaimed: true
    })
    expect(dispatchCopy('text', true)).toEqual({
      claimed: true,
      copies: 0,
      nativeCopies: [],
      releaseClaimed: false
    })
  })

  it('uses the focused native clipboard on Wayland and preserves press/release ownership', () => {
    const platform = { platform: 'linux', displayServer: 'wayland' } as const
    expect(dispatchCopy('text', false, platform)).toEqual({
      claimed: true,
      copies: 0,
      nativeCopies: [['copy']],
      releaseClaimed: true
    })
    expect(dispatchCopy('text', true, platform)).toEqual({
      claimed: true,
      copies: 0,
      nativeCopies: [],
      releaseClaimed: false
    })
    expect(dispatchCopy('', false, platform)).toEqual({
      claimed: false,
      copies: 0,
      nativeCopies: [],
      releaseClaimed: false
    })
  })

  it.each([
    { platform: 'linux', displayServer: 'x11' },
    { platform: 'linux', displayServer: null },
    { platform: 'darwin', displayServer: null },
    { platform: 'win32', displayServer: null }
  ] as const)('retains the text publisher for $platform/$displayServer', (platform) => {
    expect(dispatchCopy('text', false, platform)).toEqual({
      claimed: true,
      copies: 1,
      nativeCopies: [],
      releaseClaimed: true
    })
  })

  it('matches held and remapped copy bindings', () => {
    const keybindings = { 'terminal.copySelection': ['Mod+Shift+C'] }
    const chord = {
      key: 'c',
      code: 'KeyC',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false
    }
    expect(resolveTerminalShortcutAction(chord, true, 'false', 0, false, keybindings)).toBeNull()
    expect(
      resolveTerminalShortcutAction(
        { ...chord, shiftKey: true, repeat: true },
        true,
        'false',
        0,
        false,
        keybindings
      )
    ).toEqual({ type: 'copySelection' })
  })
})
