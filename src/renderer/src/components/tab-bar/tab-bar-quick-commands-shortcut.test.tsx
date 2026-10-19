// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TOGGLE_QUICK_COMMANDS_MENU_EVENT } from '@/lib/quick-commands-menu-events'
import { useTabBarQuickCommandsShortcut } from './tab-bar-quick-commands-shortcut'

const mock = vi.hoisted(() => ({
  platform: 'darwin',
  state: {
    activeView: 'terminal',
    keybindings: { 'tab.openQuickCommandsMenu': ['Mod+Shift+Q'] },
    settings: { terminalShortcutPolicy: 'orca-first' }
  }
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof mock.state) => unknown) => selector(mock.state)
}))
vi.mock('@/lib/shortcut-platform', () => ({ getShortcutPlatform: () => mock.platform }))

function Menu({
  isFocused,
  onOpenChange
}: {
  isFocused: boolean
  onOpenChange: (open: boolean) => void
}): null {
  useTabBarQuickCommandsShortcut({ isFocused, menuOpen: false, onOpenChange })
  return null
}

function setup() {
  const hiddenWorkspace = vi.fn()
  const left = vi.fn()
  const right = vi.fn()
  const tree = (focused: 'left' | 'right' | null) => (
    <>
      <Menu isFocused={false} onOpenChange={hiddenWorkspace} />
      <Menu isFocused={focused === 'left'} onOpenChange={left} />
      <Menu isFocused={focused === 'right'} onOpenChange={right} />
    </>
  )
  const view = render(tree('right'))
  return {
    hiddenWorkspace,
    left,
    right,
    focus: (focused: 'left' | 'right' | null) => view.rerender(tree(focused))
  }
}

function pressShortcut(): void {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Q',
        code: 'KeyQ',
        metaKey: mock.platform === 'darwin',
        ctrlKey: mock.platform !== 'darwin',
        shiftKey: true,
        cancelable: true
      })
    )
  })
}

function forwardShortcut(): void {
  act(() => {
    window.dispatchEvent(new CustomEvent(TOGGLE_QUICK_COMMANDS_MENU_EVENT))
  })
}

beforeEach(() => {
  mock.platform = 'darwin'
  mock.state.activeView = 'terminal'
  mock.state.keybindings['tab.openQuickCommandsMenu'] = ['Mod+Shift+Q']
})
afterEach(cleanup)

describe.each(['darwin', 'linux', 'win32'])(
  'quick command shortcut ownership on %s',
  (platform) => {
    it('only opens the focused split, even when hidden workspaces mounted first', () => {
      mock.platform = platform
      const menus = setup()

      pressShortcut()

      expect(menus.right).toHaveBeenCalledExactlyOnceWith(true)
      expect(menus.left).not.toHaveBeenCalled()
      expect(menus.hiddenWorkspace).not.toHaveBeenCalled()
    })
  }
)

describe('quick command shortcut ownership changes', () => {
  it('only forwards Electron shortcuts to the focused split', () => {
    const menus = setup()

    forwardShortcut()

    expect(menus.right).toHaveBeenCalledExactlyOnceWith(true)
    expect(menus.left).not.toHaveBeenCalled()
    expect(menus.hiddenWorkspace).not.toHaveBeenCalled()
  })

  it('moves both shortcut listeners when focus changes and removes them when hidden', () => {
    const menus = setup()
    menus.focus('left')

    pressShortcut()
    forwardShortcut()

    expect(menus.left).toHaveBeenCalledTimes(2)
    expect(menus.right).not.toHaveBeenCalled()
    expect(menus.hiddenWorkspace).not.toHaveBeenCalled()

    menus.focus(null)
    pressShortcut()
    forwardShortcut()
    expect(menus.left).toHaveBeenCalledTimes(2)
  })

  it('removes both shortcut listeners when leaving the terminal view', () => {
    const menus = setup()
    mock.state.activeView = 'settings'
    menus.focus('right')

    pressShortcut()
    forwardShortcut()

    expect(menus.right).not.toHaveBeenCalled()
    expect(menus.left).not.toHaveBeenCalled()
    expect(menus.hiddenWorkspace).not.toHaveBeenCalled()
  })

  it('does not carry a partial modifier double-tap across focus changes', () => {
    mock.state.keybindings['tab.openQuickCommandsMenu'] = ['DoubleTap+Shift']
    const menus = setup()
    const shiftDown = () =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Shift', code: 'ShiftLeft', shiftKey: true })
      )
    const shiftUp = () =>
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', code: 'ShiftLeft' }))

    act(() => {
      shiftDown()
      shiftUp()
    })
    menus.focus('left')
    act(shiftDown)
    expect(menus.left).not.toHaveBeenCalled()
    act(() => {
      shiftUp()
      shiftDown()
    })

    expect(menus.left).toHaveBeenCalledExactlyOnceWith(true)
    expect(menus.right).not.toHaveBeenCalled()
    expect(menus.hiddenWorkspace).not.toHaveBeenCalled()
  })
})
