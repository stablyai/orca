// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerAppCommandDispatcher, type AppCommandDispatcher } from '@/lib/app-command-dispatch'
import { dispatchTerminalShortcutAction } from './terminal-keyboard-action-dispatch'
import { resolveTerminalShortcutAction } from './terminal-shortcut-policy'
import { createSpatialFocusFixture } from './spatial-focus-dispatch-fixture'
import { dispatchGlobalPluginAliasActions } from '../../app-shell/global-plugin-alias-dispatch'
import { keybindingMatchesAction } from '../../../../shared/keybindings'

vi.mock('@/lib/pane-manager/pane-lifecycle', async (importOriginal) => {
  const actual: object = await importOriginal()
  return { ...actual, openTerminal: vi.fn() }
})

const fixtures: ReturnType<typeof createSpatialFocusFixture>[] = []
let unregister: () => void
const history = vi.fn<AppCommandDispatcher>(() => true)
function fixture(vertical = true) {
  const value = createSpatialFocusFixture(vertical)
  fixtures.push(value)
  return value
}
function key(key = 'ArrowLeft', overrides: KeyboardEventInit = {}) {
  return new KeyboardEvent('keydown', {
    key,
    code: key,
    ctrlKey: true,
    altKey: true,
    cancelable: true,
    ...overrides
  })
}
function dispatch(f: ReturnType<typeof fixture>, event: KeyboardEvent) {
  const action = resolveTerminalShortcutAction(
    event,
    false,
    'false',
    0,
    false,
    f.context.keybindings,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    f.context.terminalShortcutPolicy
  )
  if (action) {
    dispatchTerminalShortcutAction(action, event, f.manager, f.context)
  }
}
beforeEach(() => {
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1)
  )
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  history.mockReset().mockReturnValue(true)
  unregister = registerAppCommandDispatcher(history)
})
afterEach(() => {
  unregister()
  fixtures.splice(0).forEach((f) => f.dispose())
  vi.unstubAllGlobals()
})

describe('spatial navigation through the production dispatcher', () => {
  it('moves to a neighbor without history and handles one event only once', () => {
    const f = fixture()
    const event = key('ArrowRight')
    dispatch(f, event)
    dispatch(f, event)
    expect(f.setActivePane).toHaveBeenCalledExactlyOnceWith(f.second.id, { focus: true })
    expect(history).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  it('runs the history action actually bound to the input, not the spatial direction', () => {
    const f = fixture()
    f.context.keybindings = {
      'worktree.history.back': [],
      'worktree.history.forward': ['Ctrl+Alt+ArrowLeft']
    }
    const event = key()
    dispatch(f, event)
    expect(history).toHaveBeenCalledExactlyOnceWith(
      'worktree.history.forward',
      'terminal-keybinding'
    )
    expect(event.defaultPrevented).toBe(true)
  })

  it.each(['unbound', 'rebound', 'terminal-first', 'unavailable', 'repeat'] as const)(
    'passes the key through when history is %s',
    (reason) => {
      const f = fixture()
      if (reason === 'unbound') {
        f.context.keybindings = { 'worktree.history.back': [] }
      }
      if (reason === 'rebound') {
        f.context.keybindings = { 'worktree.history.back': ['Ctrl+H'] }
      }
      if (reason === 'terminal-first') {
        f.context.terminalShortcutPolicy = 'terminal-first'
      }
      if (reason === 'unavailable') {
        history.mockReturnValue(false)
      }
      const event = key('ArrowLeft', { repeat: reason === 'repeat' })
      dispatch(f, event)
      expect(event.defaultPrevented).toBe(false)
      expect(f.setActivePane).not.toHaveBeenCalled()
      expect(history).toHaveBeenCalledTimes(reason === 'unavailable' ? 1 : 0)
    }
  )

  it('allows a rebound vertical chord to fall back to its matching history action', () => {
    const f = fixture()
    f.context.keybindings = { 'worktree.history.back': ['Ctrl+Alt+ArrowUp'] }
    dispatch(f, key('ArrowUp'))
    expect(history).toHaveBeenCalledExactlyOnceWith('worktree.history.back', 'terminal-keybinding')
  })

  it.each([true, false])(
    'is independent of global capture order (global first=%s)',
    (globalFirst) => {
      const f = fixture()
      const event = key()
      const globalCapture = () => {
        if (event.defaultPrevented) {
          return
        }
        dispatchGlobalPluginAliasActions({
          context: 'terminal',
          matchShortcut: (action) =>
            keybindingMatchesAction(action, event, 'linux', undefined, { context: 'terminal' }),
          runAction: (action) => history(action, 'terminal-keybinding')
        })
      }
      if (globalFirst) {
        globalCapture()
      }
      dispatch(f, event)
      if (!globalFirst) {
        globalCapture()
      }
      expect(history).toHaveBeenCalledTimes(1)
    }
  )

  it.each(['ArrowUp', 'ArrowDown'])(
    'preserves expanded layout without persistence or focus at %s edge',
    (direction) => {
      const f = fixture()
      f.expand()
      const before = f.root.innerHTML
      const event = key(direction)
      dispatch(f, event)
      expect(f.root.innerHTML).toBe(before)
      expect(f.state.expandedPaneIdRef.current).toBe(f.first.id)
      expect(f.state.persistLayoutSnapshot).not.toHaveBeenCalled()
      expect(f.state.setExpandedPaneId).not.toHaveBeenCalled()
      expect(f.state.setTabPaneExpanded).not.toHaveBeenCalled()
      expect(f.context.refreshPaneSizes).not.toHaveBeenCalled()
      expect(f.setActivePane).not.toHaveBeenCalled()
      expect(f.state.pendingPaneSizeRefreshFrameIdsRef.current).toEqual([])
      expect(event.defaultPrevented).toBe(false)
    }
  )

  it('restores expansion even if layout measurement throws', () => {
    const f = fixture()
    f.expand()
    const before = f.root.innerHTML
    f.second.container.getBoundingClientRect = () => {
      throw new Error('measurement')
    }
    expect(() => dispatch(f, key('ArrowRight'))).toThrow('measurement')
    expect(f.root.innerHTML).toBe(before)
    expect(f.state.persistLayoutSnapshot).not.toHaveBeenCalled()
  })

  it('keeps the source expanded before invoking history', () => {
    const f = fixture()
    f.expand()
    history.mockImplementation(() => {
      expect(f.state.expandedPaneIdRef.current).toBe(f.first.id)
      expect(f.second.container.style.display).toBe('none')
      return true
    })
    dispatch(f, key())
    expect(history).toHaveBeenCalledOnce()
    expect(f.state.persistLayoutSnapshot).not.toHaveBeenCalled()
    expect(f.context.refreshPaneSizes).not.toHaveBeenCalled()
  })

  it('collapses only after finding a neighbor and leaves focus ownership to PaneManager', () => {
    const f = fixture()
    f.expand()
    dispatch(f, key('ArrowRight'))
    expect(f.state.expandedPaneIdRef.current).toBeNull()
    expect(f.second.container.style.display).not.toBe('none')
    expect(f.setActivePane).toHaveBeenCalledExactlyOnceWith(f.second.id, { focus: true })
    expect(f.context.refreshPaneSizes).toHaveBeenCalledExactlyOnceWith(false)
    expect(f.state.persistLayoutSnapshot).toHaveBeenCalledOnce()
  })

  it.each([true, false])(
    'uses the applied divider size after live updates (vertical=%s)',
    (vertical) => {
      const f = fixture(vertical)
      for (const thickness of [1, 4, 32, 4]) {
        f.manager.setPaneStyleOptions({ dividerThicknessPx: thickness })
        expect(f.manager.getPaneDividerHitSize()).toBe(thickness + 6)
        f.manager.setActivePane(f.first.id, { focus: false })
        f.setActivePane.mockClear()
        f.expand()
        dispatch(f, key(vertical ? 'ArrowRight' : 'ArrowDown'))
        expect(f.manager.getActivePane()?.id).toBe(f.second.id)
        dispatch(f, key(vertical ? 'ArrowLeft' : 'ArrowUp'))
        expect(f.manager.getActivePane()?.id).toBe(f.first.id)
      }
      expect(history).not.toHaveBeenCalled()
    }
  )
  it('does not jump over a real pane across thick dividers', () => {
    const f = fixture()
    f.manager.setPaneStyleOptions({ dividerThicknessPx: 32 })
    f.second.container.getBoundingClientRect = () =>
      DOMRect.fromRect({ x: 277, y: 0, width: 100, height: 100 })
    const third = f.manager.splitPane(f.first.id, 'vertical')
    if (!third) {
      throw new Error('Expected third pane')
    }
    third.container.getBoundingClientRect = () =>
      DOMRect.fromRect({ x: 138, y: 0, width: 101, height: 100 })
    f.manager.setActivePane(f.first.id, { focus: false })
    dispatch(f, key('ArrowRight'))
    expect(f.manager.getActivePane()?.id).toBe(third.id)
    expect(history).not.toHaveBeenCalled()
  })

  it('passes a custom non-history navigation chord to the terminal at an edge', () => {
    const f = fixture()
    f.context.keybindings = { 'terminal.focusPaneLeft': ['Ctrl+H'] }
    const event = key('h', { code: 'KeyH', altKey: false })
    dispatch(f, event)
    expect(event.defaultPrevented).toBe(false)
    expect(history).not.toHaveBeenCalled()
  })
})
