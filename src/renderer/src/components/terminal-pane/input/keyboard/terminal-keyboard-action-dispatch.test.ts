// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { registerAppCommandDispatcher } from '@/lib/app-commands/app-command-dispatch'
import { useAppStore } from '@/store'
import { dispatchTerminalShortcutAction } from './terminal-keyboard-action-dispatch'
import { resolveTerminalShortcutAction } from './terminal-shortcut-policy'
import { createSpatialFocusFixture } from './spatial-focus-dispatch-fixture'
import { releaseSpatialFocusHold } from './terminal-spatial-focus-dispatch'
import { useTerminalKeyboardShortcuts } from './terminal-keyboard-hook'
import { showTerminalShortcutCaptureNotification } from '@/lib/notifications/terminal-shortcut-capture-notification'

vi.mock('@/lib/pane-manager/pane-lifecycle', async (importOriginal) => {
  const actual: object = await importOriginal()
  return { ...actual, openTerminal: vi.fn() }
})
vi.mock('@/lib/notifications/terminal-shortcut-capture-notification', () => ({
  showTerminalShortcutCaptureNotification: vi.fn()
}))

const fixtures: ReturnType<typeof createSpatialFocusFixture>[] = []
const history = vi.fn<(direction: 'back' | 'forward') => void>()
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
function mountKeyboardHook(f: ReturnType<typeof fixture>) {
  renderHook(() =>
    useTerminalKeyboardShortcuts({
      ...f.context,
      isActive: true,
      keyboardScopeRef: { current: f.root },
      panePtyBindingsRef: { current: new Map() },
      onSearchSelectedText: vi.fn(),
      searchStateRef: { current: { query: '', caseSensitive: false, regex: false } },
      macOptionAsAltRef: { current: 'false' }
    })
  )
}
function coverPane(pane: ReturnType<typeof fixture>['first']) {
  const cover = document.createElement('div')
  cover.className = 'native-chat-pane-shell'
  const transcript = document.createElement('div')
  const composer = document.createElement('textarea')
  cover.append(transcript, composer)
  pane.container.append(cover)
  return { transcript, composer }
}
beforeEach(() => {
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1)
  )
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  history.mockReset()
  vi.mocked(showTerminalShortcutCaptureNotification).mockClear()
  useAppStore.setState({
    activeView: 'terminal',
    goBackWorktree: () => history('back'),
    goForwardWorktree: () => history('forward')
  })
  releaseSpatialFocusHold()
})
afterEach(() => {
  cleanup()
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
    expect(history).toHaveBeenCalledExactlyOnceWith('forward')
    expect(event.defaultPrevented).toBe(true)
  })

  it('shows the one-time capture notice for the history it ran', () => {
    const f = fixture()
    dispatch(f, key())
    expect(showTerminalShortcutCaptureNotification).toHaveBeenCalledExactlyOnceWith({
      actionId: 'worktree.history.back',
      platform: 'linux',
      keybindings: undefined
    })
  })

  it('absorbs the chord at an edge outside the terminal view, as main did', () => {
    const f = fixture()
    // The floating terminal over Tasks, where the app's own history command would still run.
    useAppStore.setState({ activeView: 'tasks' })
    const unregister = registerAppCommandDispatcher(() => {
      useAppStore.getState().goBackWorktree()
      return true
    })
    const event = key()
    dispatch(f, event)
    unregister()
    expect(history).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
    expect(f.setActivePane).not.toHaveBeenCalled()
    expect(showTerminalShortcutCaptureNotification).not.toHaveBeenCalled()
  })

  it('leaves the chord to the terminal at an edge under terminal-first', () => {
    const f = fixture()
    f.context.terminalShortcutPolicy = 'terminal-first'
    const event = key()
    dispatch(f, event)
    expect(history).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
    expect(f.setActivePane).not.toHaveBeenCalled()
  })

  it('passes a held chord through at an edge when nothing claimed its first press', () => {
    const f = fixture()
    const first = key('ArrowUp')
    const held = key('ArrowUp', { repeat: true })
    dispatch(f, first)
    dispatch(f, held)
    expect(first.defaultPrevented).toBe(false)
    expect(held.defaultPrevented).toBe(false)
    expect(f.setActivePane).not.toHaveBeenCalled()
    expect(history).not.toHaveBeenCalled()
  })

  it('swallows a held chord at an edge without falling back to history', () => {
    const f = fixture()
    dispatch(f, key('ArrowRight'))
    const event = key('ArrowRight', { repeat: true })
    const stopImmediatePropagation = vi.spyOn(event, 'stopImmediatePropagation')
    dispatch(f, event)
    expect(event.defaultPrevented).toBe(true)
    expect(stopImmediatePropagation).toHaveBeenCalled()
    expect(f.setActivePane).toHaveBeenCalledExactlyOnceWith(f.second.id, { focus: true })
    expect(history).not.toHaveBeenCalled()
  })

  it('swallows a held chord whose first press another owner took', () => {
    const f = fixture(false)
    dispatch(f, key('ArrowDown'))
    f.manager.setActivePane(f.first.id, { focus: false })
    f.setActivePane.mockClear()
    const taken = key('ArrowDown')
    taken.preventDefault()
    dispatch(f, taken)
    const event = key('ArrowDown', { repeat: true })
    dispatch(f, event)
    expect(event.defaultPrevented).toBe(true)
    expect(f.setActivePane).not.toHaveBeenCalled()
    expect(history).not.toHaveBeenCalled()
  })

  it('swallows a held chord whose first press it never saw, without history or a move', () => {
    const f = fixture()
    f.manager.setActivePane(f.second.id, { focus: false })
    f.setActivePane.mockClear()
    const event = key('ArrowLeft', { repeat: true })
    dispatch(f, event)
    expect(event.defaultPrevented).toBe(true)
    expect(f.setActivePane).not.toHaveBeenCalled()
    expect(history).not.toHaveBeenCalled()
  })

  it('keeps walking to a neighbor while the chord is held', () => {
    const f = fixture()
    dispatch(f, key('ArrowRight'))
    // Stand in for a longer row: the held chord meets another pane on its right.
    f.manager.setActivePane(f.first.id, { focus: false })
    f.setActivePane.mockClear()
    const event = key('ArrowRight', { repeat: true })
    dispatch(f, event)
    expect(f.setActivePane).toHaveBeenCalledExactlyOnceWith(f.second.id, { focus: true })
    expect(event.defaultPrevented).toBe(true)
    expect(history).not.toHaveBeenCalled()
  })

  it('swallows a held chord in the destination after a history fallback', () => {
    const source = fixture()
    dispatch(source, key())
    const destination = fixture()
    destination.manager.setActivePane(destination.second.id, { focus: false })
    destination.setActivePane.mockClear()
    const event = key('ArrowLeft', { repeat: true })
    dispatch(destination, event)
    expect(event.defaultPrevented).toBe(true)
    expect(destination.setActivePane).not.toHaveBeenCalled()
    expect(history).toHaveBeenCalledOnce()
  })

  it('allows a rebound vertical chord to fall back to its matching history action', () => {
    const f = fixture()
    f.context.keybindings = { 'worktree.history.back': ['Ctrl+Alt+ArrowUp'] }
    dispatch(f, key('ArrowUp'))
    expect(history).toHaveBeenCalledExactlyOnceWith('back')
  })

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

  it.each([
    { vertical: true, forward: 'ArrowRight', back: 'ArrowLeft' },
    { vertical: false, forward: 'ArrowDown', back: 'ArrowUp' }
  ])('uses the applied divider size after live updates (vertical=$vertical)', (layout) => {
    const f = fixture(layout.vertical)
    for (const thickness of [1, 4, 32, 4]) {
      f.manager.setPaneStyleOptions({ dividerThicknessPx: thickness })
      f.manager.setActivePane(f.first.id, { focus: false })
      f.setActivePane.mockClear()
      f.expand()
      dispatch(f, key(layout.forward))
      expect(f.manager.getActivePane()?.id).toBe(f.second.id)
      dispatch(f, key(layout.back))
      expect(f.manager.getActivePane()?.id).toBe(f.first.id)
    }
    expect(history).not.toHaveBeenCalled()
  })
})

describe('spatial hold release through the keyboard hook', () => {
  it.each([
    {
      release: 'its arrow keyup',
      end: () =>
        window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', code: 'ArrowRight' }))
    },
    {
      release: 'an Alt keyup',
      end: () => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt', code: 'AltLeft' }))
    },
    {
      release: 'a Meta (Cmd) keyup',
      end: () => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta', code: 'MetaLeft' }))
    },
    { release: 'window blur', end: () => window.dispatchEvent(new Event('blur')) }
  ])('stops a held walk after $release', ({ end }) => {
    const f = fixture()
    mountKeyboardHook(f)
    f.first.container.dispatchEvent(key('ArrowRight', { bubbles: true }))
    end()
    f.manager.setActivePane(f.first.id, { focus: false })
    f.setActivePane.mockClear()
    const held = key('ArrowRight', { repeat: true, bubbles: true })
    f.first.container.dispatchEvent(held)
    expect(held.defaultPrevented).toBe(true)
    expect(f.setActivePane).not.toHaveBeenCalled()
  })
})

describe('spatial navigation from a native chat cover', () => {
  it.each(['composer', 'transcript'] as const)(
    'walks out of the covered pane from its %s',
    (surface) => {
      const f = fixture()
      mountKeyboardHook(f)
      // The left pane stays active, so the walk must start from the pane the chat covers.
      const event = key('ArrowLeft', { bubbles: true })
      coverPane(f.second)[surface].dispatchEvent(event)
      expect(f.manager.getActivePane()?.id).toBe(f.first.id)
      expect(event.defaultPrevented).toBe(true)
      expect(history).not.toHaveBeenCalled()
    }
  )

  it('walks out of the covered pane from its composer with Cmd on macOS', () => {
    const userAgent = vi
      .spyOn(navigator, 'userAgent', 'get')
      .mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    onTestFinished(() => userAgent.mockRestore())
    const f = fixture()
    mountKeyboardHook(f)
    const event = key('ArrowLeft', { ctrlKey: false, metaKey: true, bubbles: true })
    coverPane(f.second).composer.dispatchEvent(event)
    expect(f.manager.getActivePane()?.id).toBe(f.first.id)
    expect(event.defaultPrevented).toBe(true)
    expect(history).not.toHaveBeenCalled()
  })

  // macOS: the shared matcher reads a Ctrl+Alt Process chord as AltGr text on Windows/Linux.
  it.each([{ isComposing: true }, { key: 'Process' }])(
    'walks out of the composer mid-composition (%o)',
    (composition) => {
      const userAgent = vi
        .spyOn(navigator, 'userAgent', 'get')
        .mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
      onTestFinished(() => userAgent.mockRestore())
      const f = fixture()
      mountKeyboardHook(f)
      const event = key('ArrowLeft', {
        ctrlKey: false,
        metaKey: true,
        bubbles: true,
        ...composition
      })
      coverPane(f.second).composer.dispatchEvent(event)
      expect(f.manager.getActivePane()?.id).toBe(f.first.id)
      expect(event.defaultPrevented).toBe(true)
      expect(history).not.toHaveBeenCalled()
    }
  )

  it('leaves a spatial chord the composer edits with to the composer', () => {
    const f = fixture()
    f.context.keybindings = { 'terminal.focusPaneLeft': ['Alt+ArrowLeft'] }
    mountKeyboardHook(f)
    const event = key('ArrowLeft', { ctrlKey: false, bubbles: true })
    coverPane(f.second).composer.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(f.setActivePane).not.toHaveBeenCalledWith(f.first.id, { focus: true })
  })

  it('keeps a rebound non-arrow spatial chord with the composer mid-composition', () => {
    const userAgent = vi
      .spyOn(navigator, 'userAgent', 'get')
      .mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    onTestFinished(() => userAgent.mockRestore())
    const f = fixture()
    f.context.keybindings = { 'terminal.focusPaneLeft': ['Mod+Alt+H'] }
    mountKeyboardHook(f)
    const event = key('Process', { code: 'KeyH', ctrlKey: false, metaKey: true, bubbles: true })
    coverPane(f.second).composer.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(f.setActivePane).not.toHaveBeenCalledWith(f.first.id, { focus: true })
  })

  it('runs history at a chat cover edge under terminal-first, as main did, without the notice', () => {
    const f = fixture()
    f.context.terminalShortcutPolicy = 'terminal-first'
    mountKeyboardHook(f)
    const event = key('ArrowLeft', { bubbles: true })
    coverPane(f.first).composer.dispatchEvent(event)
    expect(history).toHaveBeenCalledExactlyOnceWith('back')
    expect(event.defaultPrevented).toBe(true)
    expect(showTerminalShortcutCaptureNotification).not.toHaveBeenCalled()
  })
})
