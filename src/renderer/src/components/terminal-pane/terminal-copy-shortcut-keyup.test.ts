// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ settings: {} }) }
}))

const { dispatchTerminalShortcutAction } = await import('./terminal-keyboard-action-dispatch')
const { createTerminalNativeOnlyShortcutTracker } = await import('./terminal-native-only-shortcut')

function createHarness(selection: string) {
  const tracker = createTerminalNativeOnlyShortcutTracker()
  const terminal = {
    getSelection: () => selection,
    clearSelection: vi.fn(),
    scrollToLine: vi.fn(),
    scrollToBottom: vi.fn()
  }
  const managerStub = { getActivePane: () => ({ terminal }), getPanes: () => [] }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch only reads the active pane's terminal on these paths.
  const manager = managerStub as unknown as PaneManager
  const context: Parameters<typeof dispatchTerminalShortcutAction>[3] = {
    tabId: 'tab-1',
    worktreeId: 'folder-1',
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
    armNativeOnlyShortcut: (event) => tracker.armKeyDown(event)
  }
  return { tracker, manager, context }
}

const copyKeyDown = (): KeyboardEvent =>
  new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', metaKey: true, cancelable: true })
// macOS delivers this keyup only when Cmd is released before C.
const copyKeyUp = (): KeyboardEvent => new KeyboardEvent('keyup', { key: 'c', code: 'KeyC' })

describe('copy shortcut keyup ownership (#17606)', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ui: { writeTerminalClipboardText: vi.fn().mockResolvedValue(undefined) } }
    })
  })

  it('owns the keyup of a handled copy so kitty cannot report it as input', () => {
    const { tracker, manager, context } = createHarness('selected text')
    const keyDown = copyKeyDown()
    dispatchTerminalShortcutAction({ type: 'copySelection' }, keyDown, manager, context)
    expect(keyDown.defaultPrevented).toBe(true)
    expect(tracker.consumeCompanion(copyKeyUp())).toBe(true)
    expect(tracker.consumeCompanion(copyKeyUp())).toBe(false)
  })

  it('leaves the keyup to xterm when there is nothing to copy', () => {
    const { tracker, manager, context } = createHarness('')
    const keyDown = copyKeyDown()
    dispatchTerminalShortcutAction({ type: 'copySelection' }, keyDown, manager, context)
    expect(keyDown.defaultPrevented).toBe(false)
    expect(tracker.consumeCompanion(copyKeyUp())).toBe(false)
  })

  it('owns the keyup of a viewport scroll shortcut', () => {
    const { tracker, manager, context } = createHarness('')
    const keyDown = new KeyboardEvent('keydown', { key: 'Home', code: 'Home', metaKey: true })
    dispatchTerminalShortcutAction(
      { type: 'scrollViewport', position: 'top' },
      keyDown,
      manager,
      context
    )
    expect(
      tracker.consumeCompanion(new KeyboardEvent('keyup', { key: 'Home', code: 'Home' }))
    ).toBe(true)
  })
})
