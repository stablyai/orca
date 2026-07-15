// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import type { PaneCwdMap } from './resolve-split-cwd'
import { useTerminalKeyboardShortcuts } from './keyboard-handlers'

const mocks = vi.hoisted(() => ({
  splitTerminalPaneWithInheritedCwd: vi.fn(),
  prefetchLayoutBaseCharacters: vi.fn()
}))

vi.mock('./terminal-pane-split-with-inherited-cwd', () => ({
  splitTerminalPaneWithInheritedCwd: mocks.splitTerminalPaneWithInheritedCwd
}))

vi.mock('@/lib/keyboard-layout/layout-base-character', () => ({
  getLayoutBaseCharacterForCode: () => undefined,
  prefetchLayoutBaseCharacters: mocks.prefetchLayoutBaseCharacters
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ activeContextualTourId: null })
  }
}))

function renderSplitShortcuts(canSplitPane: boolean): {
  target: HTMLTextAreaElement
  setExpandedPane: ReturnType<typeof vi.fn>
  unmount: () => void
} {
  const pane = {
    id: 1,
    leafId: 'leaf-1',
    terminal: {}
  } as unknown as ManagedPane
  const manager = {
    getActivePane: () => pane,
    getPanes: () => [pane]
  } as unknown as PaneManager
  const scope = document.createElement('div')
  const target = document.createElement('textarea')
  target.className = 'xterm-helper-textarea'
  scope.append(target)
  document.body.append(scope)
  target.focus()
  const setExpandedPane = vi.fn()

  const hook = renderHook(() =>
    useTerminalKeyboardShortcuts({
      tabId: 'tab-1',
      worktreeId: 'worktree-1',
      isActive: true,
      canSplitPane,
      keyboardScopeRef: { current: scope },
      managerRef: { current: manager },
      paneTransportsRef: { current: new Map<number, PtyTransport>() },
      panePtyBindingsRef: { current: new Map() },
      paneCwdRef: { current: new Map() as PaneCwdMap },
      fallbackCwd: '',
      expandedPaneIdRef: { current: 1 },
      setExpandedPane,
      restoreExpandedLayout: vi.fn(),
      refreshPaneSizes: vi.fn(),
      persistLayoutSnapshot: vi.fn(),
      toggleExpandPane: vi.fn(),
      setSearchOpen: vi.fn(),
      onSearchSelectedText: vi.fn(),
      onRequestClosePane: vi.fn(),
      onClearPaneScrollback: vi.fn(),
      onSetTitle: vi.fn(),
      onClearPaneTitle: vi.fn(),
      searchOpenRef: { current: false },
      searchStateRef: { current: { query: '', caseSensitive: false, regex: false } },
      macOptionAsAltRef: { current: 'false' }
    })
  )

  return {
    target,
    setExpandedPane,
    unmount: () => {
      hook.unmount()
      scope.remove()
    }
  }
}

function dispatchMacSplit(target: HTMLElement): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'd',
    code: 'KeyD',
    metaKey: true,
    bubbles: true,
    cancelable: true
  })
  act(() => target.dispatchEvent(event))
  return event
}

describe('terminal keyboard split policy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.replaceChildren()
  })

  it('consumes split chords without mutating a maintained grid', () => {
    const hook = renderSplitShortcuts(false)

    const event = dispatchMacSplit(hook.target)

    expect(event.defaultPrevented).toBe(true)
    expect(mocks.splitTerminalPaneWithInheritedCwd).not.toHaveBeenCalled()
    expect(hook.setExpandedPane).not.toHaveBeenCalled()
    hook.unmount()
  })

  it('retains split chords and expanded-pane recovery for ordinary tabs', () => {
    const hook = renderSplitShortcuts(true)

    const event = dispatchMacSplit(hook.target)

    expect(event.defaultPrevented).toBe(true)
    expect(hook.setExpandedPane).toHaveBeenCalledWith(null)
    expect(mocks.splitTerminalPaneWithInheritedCwd).toHaveBeenCalledWith(
      expect.objectContaining({ direction: 'vertical', source: 'keyboard' })
    )
    hook.unmount()
  })
})
