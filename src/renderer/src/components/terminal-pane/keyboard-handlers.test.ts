// src/renderer/src/components/terminal-pane/keyboard-handlers.test.ts
import { afterEach, describe, it, expect, vi } from 'vitest'
import { useEffect } from 'react'
import type * as React from 'react'
import { FIND_QUERY_MAX_BYTES } from '@/lib/find-query-bounds'
import type { KeybindingOverrides } from '../../../../shared/keybindings'

const { resetTerminalKeyboardProtocolAfterInterruptMock } = vi.hoisted(() => ({
  resetTerminalKeyboardProtocolAfterInterruptMock: vi.fn()
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return { ...actual, useEffect: vi.fn() }
})
vi.mock('./use-terminal-pane-lifecycle', () => ({
  resetTerminalKeyboardProtocolAfterInterrupt: resetTerminalKeyboardProtocolAfterInterruptMock
}))
import {
  matchFileSearchShortcut,
  matchSearchNavigate,
  resolveTerminalKeyboardShortcutAction,
  runTerminalSearchNavigation,
  useTerminalKeyboardShortcuts
} from './keyboard-handlers'

function makeKeyEvent(
  overrides: Partial<{
    key: string
    metaKey: boolean
    ctrlKey: boolean
    shiftKey: boolean
    altKey: boolean
    repeat: boolean
  }>
): Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'repeat'> {
  return {
    key: 'g',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    ...overrides
  }
}

describe('matchSearchNavigate', () => {
  const isMac = true
  const searchState = { query: 'hello', caseSensitive: false, regex: false }

  it('returns "next" for Cmd+G on macOS', () => {
    const e = makeKeyEvent({ metaKey: true })
    expect(matchSearchNavigate(e, isMac, true, searchState)).toBe('next')
  })

  it('returns "previous" for Cmd+Shift+G on macOS', () => {
    const e = makeKeyEvent({ metaKey: true, shiftKey: true })
    expect(matchSearchNavigate(e, isMac, true, searchState)).toBe('previous')
  })

  it('returns null when search is closed', () => {
    const e = makeKeyEvent({ metaKey: true })
    expect(matchSearchNavigate(e, isMac, false, searchState)).toBeNull()
  })

  it('returns null when query is empty', () => {
    const e = makeKeyEvent({ metaKey: true })
    expect(
      matchSearchNavigate(e, isMac, true, { query: '', caseSensitive: false, regex: false })
    ).toBeNull()
  })

  it('returns null when query is too large for bounded terminal search', () => {
    const e = makeKeyEvent({ metaKey: true })
    expect(
      matchSearchNavigate(e, isMac, true, {
        query: 'x'.repeat(FIND_QUERY_MAX_BYTES + 1),
        caseSensitive: false,
        regex: false
      })
    ).toBeNull()
  })

  it('returns null for wrong key', () => {
    const e = makeKeyEvent({ metaKey: true, key: 'f' })
    expect(matchSearchNavigate(e, isMac, true, searchState)).toBeNull()
  })

  it('returns null when alt is pressed', () => {
    const e = makeKeyEvent({ metaKey: true, altKey: true })
    expect(matchSearchNavigate(e, isMac, true, searchState)).toBeNull()
  })

  it('returns "next" for Ctrl+G on Linux/Windows', () => {
    const e = makeKeyEvent({ ctrlKey: true })
    expect(matchSearchNavigate(e, false, true, searchState)).toBe('next')
  })

  it('returns "previous" for Ctrl+Shift+G on Linux/Windows', () => {
    const e = makeKeyEvent({ ctrlKey: true, shiftKey: true })
    expect(matchSearchNavigate(e, false, true, searchState)).toBe('previous')
  })

  it('returns null for Ctrl+G on macOS (wrong modifier)', () => {
    const e = makeKeyEvent({ ctrlKey: true })
    expect(matchSearchNavigate(e, true, true, searchState)).toBeNull()
  })
})

describe('resolveTerminalKeyboardShortcutAction', () => {
  it('routes macOS Shift+Enter with the active Windows PTY host bytes', () => {
    expect(
      resolveTerminalKeyboardShortcutAction(
        makeKeyEvent({ key: 'Enter', shiftKey: true }),
        true,
        'false',
        0,
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        () => 'alt-enter',
        () => true
      )
    ).toEqual({ type: 'sendInput', data: '\x1b\r' })
  })
})

describe('runTerminalSearchNavigation', () => {
  const searchState = { query: 'hello', caseSensitive: true, regex: false }

  it('runs the next search through the guarded xterm path', () => {
    const findNext = vi.fn(() => true)
    const findPrevious = vi.fn(() => false)
    const pane = { searchAddon: { findNext, findPrevious } } as unknown as Parameters<
      typeof runTerminalSearchNavigation
    >[0]

    expect(runTerminalSearchNavigation(pane, 'next', searchState)).toBe(true)
    expect(findNext).toHaveBeenCalledWith('hello', { caseSensitive: true, regex: false })
    expect(findPrevious).not.toHaveBeenCalled()
  })

  it('runs the previous search through the guarded xterm path', () => {
    const findNext = vi.fn(() => false)
    const findPrevious = vi.fn(() => true)
    const pane = { searchAddon: { findNext, findPrevious } } as unknown as Parameters<
      typeof runTerminalSearchNavigation
    >[0]

    expect(runTerminalSearchNavigation(pane, 'previous', searchState)).toBe(true)
    expect(findPrevious).toHaveBeenCalledWith('hello', { caseSensitive: true, regex: false })
    expect(findNext).not.toHaveBeenCalled()
  })

  it('contains the xterm decoration positive-integer crash from shortcut navigation', () => {
    const findNext = vi.fn(() => {
      throw new Error('This API only accepts positive integers')
    })
    const pane = { searchAddon: { findNext } } as unknown as Parameters<
      typeof runTerminalSearchNavigation
    >[0]

    expect(() => runTerminalSearchNavigation(pane, 'next', searchState)).not.toThrow()
    expect(runTerminalSearchNavigation(pane, 'next', searchState)).toBe(false)
  })
})

describe('matchFileSearchShortcut', () => {
  it('matches Cmd+Shift+F on macOS', () => {
    expect(
      matchFileSearchShortcut(makeKeyEvent({ key: 'F', metaKey: true, shiftKey: true }), 'darwin')
    ).toBe(true)
  })

  it('matches Ctrl+Shift+F on Linux/Windows', () => {
    expect(
      matchFileSearchShortcut(makeKeyEvent({ key: 'F', ctrlKey: true, shiftKey: true }), 'linux')
    ).toBe(true)
  })

  it('rejects repeats, alt, and the wrong platform modifier', () => {
    expect(
      matchFileSearchShortcut(
        makeKeyEvent({ key: 'F', metaKey: true, shiftKey: true, repeat: true }),
        'darwin'
      )
    ).toBe(false)
    expect(
      matchFileSearchShortcut(
        makeKeyEvent({ key: 'F', metaKey: true, shiftKey: true, altKey: true }),
        'darwin'
      )
    ).toBe(false)
    expect(
      matchFileSearchShortcut(makeKeyEvent({ key: 'F', ctrlKey: true, shiftKey: true }), 'darwin')
    ).toBe(false)
  })

  it('follows customized file-search bindings', () => {
    const overrides = { 'sidebar.search.toggle': ['Ctrl+Alt+S'] }

    expect(
      matchFileSearchShortcut(
        makeKeyEvent({ key: 's', ctrlKey: true, altKey: true }),
        'linux',
        overrides
      )
    ).toBe(true)
    expect(
      matchFileSearchShortcut(
        makeKeyEvent({ key: 'F', ctrlKey: true, shiftKey: true }),
        'linux',
        overrides
      )
    ).toBe(false)
  })

  it('lets terminal-first pass the file-search shortcut through to the terminal', () => {
    expect(
      matchFileSearchShortcut(
        makeKeyEvent({ key: 'F', metaKey: true, shiftKey: true }),
        'darwin',
        undefined,
        'terminal-first'
      )
    ).toBe(false)
  })

  it('does not match when file search is disabled', () => {
    expect(
      matchFileSearchShortcut(makeKeyEvent({ key: 'F', metaKey: true, shiftKey: true }), 'darwin', {
        'sidebar.search.toggle': []
      })
    ).toBe(false)
  })
})

describe('useTerminalKeyboardShortcuts copy selection', () => {
  function CopyShortcutHarness(deps: Parameters<typeof useTerminalKeyboardShortcuts>[0]): null {
    useTerminalKeyboardShortcuts(deps)
    return null
  }

  function installCopyShortcutHarness(options: {
    selection: string
    mouseTrackingMode: 'none' | 'normal' | 'drag' | 'any'
    altKey?: boolean
    ctrlKey?: boolean
    keybindings?: KeybindingOverrides
    metaKey?: boolean
    repeat?: boolean
    shiftKey?: boolean
    userAgent?: string
  }): {
    clearActivePane: ReturnType<typeof vi.fn>
    input: ReturnType<typeof vi.fn>
    writeClipboardText: ReturnType<typeof vi.fn>
    event: Pick<
      KeyboardEvent,
      'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'repeat'
    > & {
      target: null
      preventDefault: ReturnType<typeof vi.fn>
      stopImmediatePropagation: ReturnType<typeof vi.fn>
    }
    dispose: () => void
  } {
    const listeners = new Map<string, EventListener>()
    const clearActivePane = vi.fn()
    const input = vi.fn()
    const writeClipboardText = vi.fn(() => Promise.resolve())
    const pane = {
      id: 1,
      leafId: 'leaf-1',
      terminal: {
        getSelection: vi.fn(() => options.selection),
        clearSelection: vi.fn(),
        input,
        modes: { mouseTrackingMode: options.mouseTrackingMode }
      }
    }
    const manager = {
      getActivePane: vi.fn(() => pane),
      getPanes: vi.fn(() => [pane])
    }

    vi.stubGlobal('navigator', {
      userAgent: options.userAgent ?? 'Mozilla/5.0 (Macintosh)'
    })
    vi.stubGlobal('HTMLElement', class HTMLElement {})
    vi.stubGlobal('window', {
      navigator: globalThis.navigator,
      api: { ui: { writeTerminalClipboardText: writeClipboardText } },
      addEventListener: (type: string, listener: EventListener) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type)
    })

    let disposeEffect: (() => void) | undefined
    vi.mocked(useEffect).mockImplementation((effect) => {
      disposeEffect = effect() as (() => void) | undefined
    })
    CopyShortcutHarness({
      tabId: 'tab-1',
      worktreeId: 'worktree-1',
      isActive: true,
      keyboardScopeRef: { current: null },
      managerRef: { current: manager } as never,
      paneTransportsRef: { current: new Map() },
      panePtyBindingsRef: { current: new Map() },
      paneCwdRef: { current: new Map() },
      fallbackCwd: '/workspace',
      expandedPaneIdRef: { current: null },
      setExpandedPane: vi.fn(),
      restoreExpandedLayout: vi.fn(),
      refreshPaneSizes: vi.fn(),
      persistLayoutSnapshot: vi.fn(),
      toggleExpandPane: vi.fn(),
      setSearchOpen: vi.fn(),
      onSearchSelectedText: vi.fn(),
      onRequestClosePane: vi.fn(),
      onClearPaneScrollback: clearActivePane,
      onSetTitle: vi.fn(),
      onClearPaneTitle: vi.fn(),
      searchOpenRef: { current: false },
      searchStateRef: { current: { query: '', caseSensitive: false, regex: false } },
      macOptionAsAltRef: { current: 'false' },
      keybindings: options.keybindings
    })

    const event = {
      key: 'c',
      code: 'KeyC',
      metaKey: options.metaKey ?? true,
      ctrlKey: options.ctrlKey ?? false,
      altKey: options.altKey ?? false,
      shiftKey: options.shiftKey ?? false,
      repeat: options.repeat ?? false,
      target: null,
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn()
    }
    const onKeyDown = listeners.get('keydown')
    expect(onKeyDown).toBeDefined()
    onKeyDown?.(event as unknown as Event)

    return {
      clearActivePane,
      input,
      writeClipboardText,
      event,
      dispose: () => {
        disposeEffect?.()
      }
    }
  }

  afterEach(() => {
    resetTerminalKeyboardProtocolAfterInterruptMock.mockClear()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('forwards an empty selection from the configured terminal copy chord to a mouse-capturing TUI', () => {
    const harness = installCopyShortcutHarness({
      selection: '',
      mouseTrackingMode: 'any',
      altKey: true,
      keybindings: { 'terminal.copySelection': ['Mod+Alt+C'] }
    })

    expect(harness.input).toHaveBeenCalledWith('\x03')
    expect(resetTerminalKeyboardProtocolAfterInterruptMock).toHaveBeenCalledWith(
      expect.objectContaining({ input: harness.input })
    )
    expect(harness.writeClipboardText).not.toHaveBeenCalled()
    expect(harness.event.preventDefault).toHaveBeenCalledOnce()
    expect(harness.event.stopImmediatePropagation).toHaveBeenCalledOnce()
    harness.dispose()
  })

  it('forwards macOS Cmd+C from an empty mouse-capturing TUI selection', () => {
    const harness = installCopyShortcutHarness({ selection: '', mouseTrackingMode: 'any' })

    expect(harness.input).toHaveBeenCalledWith('\x03')
    expect(harness.writeClipboardText).not.toHaveBeenCalled()
    expect(harness.event.preventDefault).toHaveBeenCalledOnce()
    expect(harness.event.stopImmediatePropagation).toHaveBeenCalledOnce()
    harness.dispose()
  })

  it.each([
    ['Linux', 'normal'],
    ['Windows', 'drag']
  ] as const)(
    'forwards the configured copy chord on %s in %s mouse-tracking mode',
    (platform, mouseTrackingMode) => {
      const harness = installCopyShortcutHarness({
        selection: '',
        mouseTrackingMode,
        userAgent: `Mozilla/5.0 (${platform})`,
        metaKey: false,
        ctrlKey: true,
        shiftKey: true,
        keybindings: { 'terminal.copySelection': ['Mod+Shift+C'] }
      })

      expect(harness.input).toHaveBeenCalledWith('\x03')
      expect(harness.writeClipboardText).not.toHaveBeenCalled()
      expect(harness.event.preventDefault).toHaveBeenCalledOnce()
      expect(harness.event.stopImmediatePropagation).toHaveBeenCalledOnce()
      harness.dispose()
    }
  )

  it('ignores repeated macOS Cmd+C from a mouse-capturing TUI selection', () => {
    const harness = installCopyShortcutHarness({
      selection: '',
      mouseTrackingMode: 'any',
      repeat: true
    })

    expect(harness.input).not.toHaveBeenCalled()
    expect(harness.writeClipboardText).not.toHaveBeenCalled()
    expect(harness.event.preventDefault).not.toHaveBeenCalled()
    expect(harness.event.stopImmediatePropagation).not.toHaveBeenCalled()
    harness.dispose()
  })

  it('ignores a repeated configured copy chord', () => {
    const harness = installCopyShortcutHarness({
      selection: '',
      mouseTrackingMode: 'any',
      altKey: true,
      repeat: true,
      keybindings: { 'terminal.copySelection': ['Mod+Alt+C'] }
    })

    expect(harness.input).not.toHaveBeenCalled()
    expect(harness.writeClipboardText).not.toHaveBeenCalled()
    expect(harness.event.preventDefault).not.toHaveBeenCalled()
    expect(harness.event.stopImmediatePropagation).not.toHaveBeenCalled()
    harness.dispose()
  })

  it('keeps another action rebound to macOS Cmd+C reachable', () => {
    const harness = installCopyShortcutHarness({
      selection: 'selected',
      mouseTrackingMode: 'any',
      keybindings: {
        'terminal.copySelection': ['Mod+Shift+C'],
        'terminal.clear': ['Mod+C']
      }
    })

    expect(harness.clearActivePane).toHaveBeenCalledOnce()
    expect(harness.writeClipboardText).not.toHaveBeenCalled()
    expect(harness.input).not.toHaveBeenCalled()
    harness.dispose()
  })

  it('copies a non-empty selection without forwarding ETX', () => {
    const harness = installCopyShortcutHarness({
      selection: 'selected',
      mouseTrackingMode: 'any',
      shiftKey: true
    })

    expect(harness.writeClipboardText).toHaveBeenCalledWith('selected')
    expect(harness.input).not.toHaveBeenCalled()
    expect(harness.event.preventDefault).toHaveBeenCalledOnce()
    expect(harness.event.stopImmediatePropagation).toHaveBeenCalledOnce()
    harness.dispose()
  })

  it('leaves an empty normal-shell selection unhandled', () => {
    const harness = installCopyShortcutHarness({
      selection: '',
      mouseTrackingMode: 'none',
      shiftKey: true
    })

    expect(harness.input).not.toHaveBeenCalled()
    expect(harness.writeClipboardText).not.toHaveBeenCalled()
    expect(harness.event.preventDefault).not.toHaveBeenCalled()
    expect(harness.event.stopImmediatePropagation).not.toHaveBeenCalled()
    harness.dispose()
  })
})
