// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { ActivePluginCommand } from '@/store/plugin-panels'
import { makeGroup, makeTerminalTab, makeUnifiedTab } from '../worktree-jump-palette-test-fixtures'
import { useNativeChatToggleShortcut } from './use-native-chat-toggle-shortcut'
import { useGlobalKeybindings } from '@/app-shell/use-global-keybindings'
import { useAppChromeLayout } from '@/app-shell/use-app-chrome-layout'
import { useFloatingWorkspacePanel } from '@/app-shell/use-floating-workspace-panel'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/app-keyboard-router'
const plugins = vi.hoisted((): { commands: ActivePluginCommand[] } => ({ commands: [] }))
vi.mock('@/store/plugin-panels', () => ({ usePluginCommands: () => plugins.commands }))
vi.mock('@/lib/plugin-command-execution', () => ({ executePluginCommand: vi.fn(async () => {}) }))
vi.mock('@/lib/shortcut-platform', () => ({ getShortcutPlatform: () => 'win32' }))
vi.mock('@/app-shell/app-window-chrome', () => ({ shortcutPlatform: 'win32' }))
vi.mock('../../../../shared/native-chat/transcript/native-chat-transcript-readability', () => ({
  isNativeChatTranscriptLocalReadable: () => true
}))
import { executePluginCommand } from '@/lib/plugin-command-execution'
const initial = useAppStore.getState()
const toggle = vi.fn()
const command: ActivePluginCommand = {
  pluginKey: 'test.plugin',
  pluginName: 'Test',
  id: 'open',
  title: 'Open',
  context: 'worktree',
  handler: { type: 'built-in', action: 'view.tasks' },
  keybindings: [{ key: 'Mod+Shift+J', when: 'global' }]
}
function mountGlobal() {
  return renderHook(() =>
    useGlobalKeybindings({
      layout: useAppChromeLayout(),
      floatingWorkspace: useFloatingWorkspacePanel()
    })
  )
}
function input(target = document.body, init: KeyboardEventInit = {}, type = 'keydown') {
  const event = new KeyboardEvent(type, {
    key: 'j',
    code: 'KeyJ',
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
    ...init
  })
  Object.defineProperty(event, 'getModifierState', { value: () => false })
  target.dispatchEvent(event)
  return event
}
beforeEach(() => {
  vi.stubGlobal('navigator', { userAgent: 'Windows NT 10.0' })
  useAppStore.setState({
    activeView: 'terminal',
    activeWorktreeId: 'main',
    activeGroupIdByWorktree: { main: 'group-main' },
    groupsByWorktree: { main: [makeGroup('main', ['tab'])] },
    unifiedTabsByWorktree: { main: [makeUnifiedTab('tab', 'main', 'terminal', 'Claude')] },
    tabsByWorktree: {
      main: [{ ...makeTerminalTab('terminal', 'main', 'Claude'), launchAgent: 'claude' }]
    },
    keybindings: { 'worktree.palette': [] },
    toggleTabViewMode: toggle
  })
  plugins.commands = []
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})
it.each([true, false])(
  'preserves actual global plugin authority in either owner order (%s)',
  (globalFirst) => {
    plugins.commands = [command]
    const global = globalFirst ? mountGlobal() : null
    const owner = renderHook(() => useNativeChatToggleShortcut('main', true))
    const laterGlobal = !globalFirst ? mountGlobal() : null
    expect(input(document.body, { key: 'о' }).defaultPrevented).toBe(true)
    expect(executePluginCommand).toHaveBeenCalledTimes(1)
    expect(toggle).not.toHaveBeenCalled()
    const search = document.createElement('input')
    search.dataset.fileSearchInput = ''
    document.body.append(search)
    act(() => useAppStore.setState({ keybindings: { 'terminal.toggleNativeChat': ['Mod+Alt+Y'] } }))
    plugins.commands = [{ ...command, keybindings: [{ key: 'Mod+Alt+Y', when: 'global' }] }]
    owner.rerender()
    ;(global ?? laterGlobal)?.rerender()
    expect(
      input(search, { key: 'y', code: 'KeyY', shiftKey: false, altKey: true }).defaultPrevented
    ).toBe(true)
    expect(executePluginCommand).toHaveBeenCalledTimes(2)
    expect(
      input(search, { key: 'y', code: 'KeyZ', shiftKey: false, altKey: true }).defaultPrevented
    ).toBe(true)
    expect(
      input(search, { key: 'y', code: 'KeyY', shiftKey: false, altKey: true, isComposing: true })
        .defaultPrevented
    ).toBe(true)
    expect(toggle).toHaveBeenCalledTimes(2)
    const textarea = document.createElement('textarea')
    document.body.append(textarea)
    input(textarea, { key: 'y', code: 'KeyY', shiftKey: false, altKey: true })
    textarea.className = 'xterm-helper-textarea'
    input(textarea, { key: 'y', code: 'KeyY', shiftKey: false, altKey: true })
    expect(toggle).toHaveBeenCalledTimes(4)
    textarea.remove()
    search.remove()
  }
)
it('keeps the detector across committed plugin updates and consumes a successful gesture once', () => {
  const owner = renderHook(() => useNativeChatToggleShortcut('main', true))
  const global = mountGlobal()
  act(() =>
    useAppStore.setState({ keybindings: { 'terminal.toggleNativeChat': ['DoubleTap+Alt'] } })
  )
  const tap = (type: string) =>
    input(
      document.body,
      { key: 'Alt', code: 'AltLeft', ctrlKey: false, shiftKey: false, altKey: type === 'keydown' },
      type
    )
  tap('keydown')
  tap('keyup')
  plugins.commands = [{ ...command, keybindings: [{ key: 'DoubleTap+Alt', when: 'global' }] }]
  owner.rerender()
  global.rerender()
  expect(tap('keydown').defaultPrevented).toBe(true)
  expect(executePluginCommand).toHaveBeenCalledTimes(1)
  expect(toggle).not.toHaveBeenCalled()
  window.dispatchEvent(new Event('blur'))
  plugins.commands = []
  owner.rerender()
  global.rerender()
  tap('keydown')
  tap('keyup')
  window.dispatchEvent(new Event('blur'))
  expect(tap('keydown').defaultPrevented).toBe(false)
  tap('keyup')
  const later = vi.fn()
  addAppKeyListener('keydown', later)
  try {
    expect(tap('keydown').defaultPrevented).toBe(true)
    expect(toggle).toHaveBeenCalledTimes(1)
    expect(later).not.toHaveBeenCalled()
  } finally {
    removeAppKeyListener('keydown', later)
  }
})
it('yields the reverse held family, frees an unbound family, and refuses repeated/recording/unbound input', () => {
  renderHook(() => useNativeChatToggleShortcut('main', true))
  act(() =>
    useAppStore.setState({ keybindings: { 'terminal.toggleNativeChat': ['Ctrl+Shift+Tab'] } })
  )
  expect(input(document.body, { key: 'Tab', code: 'Tab' }).defaultPrevented).toBe(false)
  act(() =>
    useAppStore.setState({
      keybindings: { 'terminal.toggleNativeChat': ['Ctrl+Shift+Tab'], 'tab.previousRecent': [] }
    })
  )
  expect(input(document.body, { key: 'Tab', code: 'Tab' }).defaultPrevented).toBe(true)
  expect(input(document.body, { key: 'Tab', code: 'Tab', repeat: true }).defaultPrevented).toBe(
    false
  )
  const recorder = document.createElement('button')
  recorder.dataset.shortcutRecorderActive = ''
  document.body.append(recorder)
  expect(input(recorder, { key: 'Tab', code: 'Tab' }).defaultPrevented).toBe(false)
  recorder.remove()
  act(() => useAppStore.setState({ keybindings: { 'terminal.toggleNativeChat': [] } }))
  expect(input().defaultPrevented).toBe(false)
  expect(toggle).toHaveBeenCalledTimes(1)
  act(() =>
    useAppStore.setState({
      keybindings: {},
      tabsByWorktree: {
        main: [{ ...makeTerminalTab('terminal', 'main', 'Gemini'), launchAgent: 'gemini' }]
      }
    })
  )
  expect(input().defaultPrevented).toBe(false)
  expect(toggle).toHaveBeenCalledTimes(1)
})
