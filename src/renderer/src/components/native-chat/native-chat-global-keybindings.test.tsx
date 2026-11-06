// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { ActivePluginCommand } from '@/store/plugin-panels'
import { worktree } from '../sidebar/worktree-list/grouping/worktree-list-groups-test-fixtures'
import { useGlobalKeybindings } from '../../app-shell/use-global-keybindings'
import { useNativeChatComposerKeyDown } from './use-native-chat-composer-keydown'
import { RENAME_TERMINAL_TAB_EVENT } from '../tab-bar/terminal-tab-rename-request'
import { installMainWindowShortcutRouting } from '../../../../main/window/main-window-shortcut-routing'
import { registerWorkspaceShortcutIpcBridge } from '../../hooks/ipc-events/workspace-shortcut-ipc-bridge'
import type { MainWindowFocusLifecycle } from '../../../../main/window/main-window-focus-lifecycle'
import type { BrowserWindow, Input } from 'electron'

const fixture = vi.hoisted(() => {
  const context: { plugins: ActivePluginCommand[]; platform: NodeJS.Platform } = {
    plugins: [],
    platform: 'darwin'
  }
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: beforeEach supplies every store field read by this controlled fixture.
    state: {} as AppState,
    ...context,
    floating: false,
    pluginRun: vi.fn(),
    deleteWorktree: vi.fn(),
    send: vi.fn(),
    steer: vi.fn(() => true),
    explorer: vi.fn(),
    setSidebar: vi.fn(),
    openSettings: vi.fn(),
    settingsTarget: vi.fn(),
    deleteIpc: () => {},
    handlers: new Map<string, (...args: any[]) => void>()
  }
})
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: AppState) => unknown) => selector(fixture.state), {
    getState: () => fixture.state
  })
}))
vi.mock('@/store/plugin-panels', () => ({ usePluginCommands: () => fixture.plugins }))
vi.mock('@/lib/plugin-command-execution', () => ({ executePluginCommand: fixture.pluginRun }))
vi.mock('@/lib/plugin-command-replacements', () => ({
  runBuiltInOrReplacement: (_: string, run: () => void) => run()
}))
vi.mock('@/lib/floating-workspace-terminal-actions', () => ({
  isFloatingWorkspacePanelFocused: () => fixture.floating,
  isFloatingWorkspaceTerminalInputTarget: () => fixture.floating,
  matchFloatingWorkspacePanelChord: () => null,
  shouldMinimizeFloatingWorkspacePanelOnCloseShortcut: () => false
}))
vi.mock('@/lib/terminal-shortcut-capture-notification', () => ({
  showTerminalShortcutCaptureNotification: vi.fn()
}))
vi.mock('../sidebar/workspace-actions/deletion/delete-worktree-flow', () => ({
  runWorktreeDelete: fixture.deleteWorktree
}))
vi.mock('electron', () => ({ app: { isPackaged: true } }))
vi.mock('../../app-shell/app-window-chrome', () => ({
  get shortcutPlatform() {
    return fixture.platform
  }
}))

const noop = () => {}
const layout = { activeView: 'terminal', creationLayoutActive: false, workspaceChromeActive: true }
const floatingWorkspace = {
  enabled: false,
  open: false,
  visibleTabCount: 0,
  openMaximized: noop,
  setOpenWithFocus: noop
}
function Composer() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the layout members read by the mounted shortcut hook.
  useGlobalKeybindings({ layout: layout as never, floatingWorkspace: floatingWorkspace as never })
  const onKeyDown = useNativeChatComposerKeyDown({
    autocomplete: { mode: 'none' },
    mentionFiles: { files: [], loading: false, failed: false },
    completeMention: noop,
    activeSuggestion: 0,
    draft: 'draft stays',
    isComposing: () => false,
    completePickerItem: noop,
    dispatchPickerCommand: noop,
    dismissPicker: noop,
    interrupt: noop,
    send: fixture.send,
    steerHead: fixture.steer,
    setActiveSuggestion: noop,
    setDraft: noop,
    setCaret: noop
  })
  return (
    <div
      contentEditable
      suppressContentEditableWarning
      data-native-chat-prompt-editor
      onKeyDown={onKeyDown}
    >
      <p>draft stays</p>
    </div>
  )
}
function press(target: HTMLElement, key: string, code: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', {
    key,
    code,
    bubbles: true,
    cancelable: true,
    ...init
  })
  Object.defineProperty(event, 'getModifierState', { value: () => false })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}
function mount() {
  const view = render(<Composer />)
  const editor = view.getByText('draft stays').parentElement!
  editor.focus()
  return {
    editor,
    paragraph: view.getByText('draft stays'),
    rerender: () => view.rerender(<Composer />)
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mac')
  fixture.plugins = []
  fixture.floating = false
  fixture.platform = 'darwin'
  fixture.pluginRun.mockResolvedValue(undefined)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked store exposes only the fields exercised by these production handlers.
  fixture.state = {
    activeView: 'terminal',
    activeWorktreeId: 'wt-1',
    activeTabType: 'agent-session',
    activeModal: 'none',
    keybindings: { 'sidebar.sleepingWorkspaces.toggle': ['Mod+Backslash'] },
    settings: {},
    getActiveTab: () => ({ id: 'chat-tab', contentType: 'agent-session' }),
    showSleepingWorkspaces: false,
    setShowSleepingWorkspaces: (show: boolean) => {
      fixture.state.showSleepingWorkspaces = show
    },
    openSettingsPage: fixture.openSettings,
    openSettingsTarget: fixture.settingsTarget,
    setSidebarOpen: fixture.setSidebar,
    showRightSidebarFiles: fixture.explorer,
    worktreesByRepo: { 'repo-1': [{ ...worktree, hostId: 'local', instanceId: 'instance' }] },
    deleteStateByWorktreeId: {},
    repos: []
  } as unknown as AppState
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

it('renames the active chat and toggles sleeping workspaces from a nested prompt target without changing the draft', () => {
  const renamed = vi.fn()
  window.addEventListener(RENAME_TERMINAL_TAB_EVENT, renamed)
  const { editor, paragraph } = mount()
  expect(press(paragraph, 'r', 'KeyR', { metaKey: true }).defaultPrevented).toBe(true)
  expect(renamed).toHaveBeenCalledWith(expect.objectContaining({ detail: { tabId: 'chat-tab' } }))
  press(paragraph, '\\', 'Backslash', { metaKey: true })
  expect(fixture.state.showSleepingWorkspaces).toBe(true)
  press(paragraph, '\\', 'Backslash', { metaKey: true })
  expect(fixture.state.showSleepingWorkspaces).toBe(false)
  expect(editor.textContent).toBe('draft stays')
  window.removeEventListener(RENAME_TERMINAL_TAB_EVENT, renamed)
})

it('runs safe non-primary bindings and retains plugin precedence over built-ins', () => {
  fixture.state.keybindings = { 'sidebar.sleepingWorkspaces.toggle': ['Ctrl+Shift+S'] }
  const { paragraph, rerender } = mount()
  press(paragraph, 'S', 'KeyS', { ctrlKey: true, shiftKey: true })
  expect(fixture.state.showSleepingWorkspaces).toBe(true)
  fixture.state.keybindings = { 'view.plugins': ['Ctrl+Shift+S'] }
  rerender()
  press(paragraph, 'S', 'KeyS', { ctrlKey: true, shiftKey: true })
  expect(fixture.settingsTarget).toHaveBeenCalledExactlyOnceWith({
    pane: 'plugins',
    repoId: null,
    intent: undefined
  })
  expect(fixture.openSettings).toHaveBeenCalledOnce()
  fixture.plugins.push({
    pluginKey: 'fixture',
    pluginName: 'Fixture',
    id: 'open',
    title: 'Open',
    context: 'global',
    handler: { type: 'built-in', action: 'view.tasks' },
    keybindings: [{ key: 'Mod+R', when: 'global' }]
  })
  const renamed = vi.fn()
  window.addEventListener(RENAME_TERMINAL_TAB_EVENT, renamed)
  // Re-render commits the current plugin list to the production dispatcher.
  cleanup()
  const next = mount()
  press(next.paragraph, 'r', 'KeyR', { metaKey: true })
  expect(fixture.pluginRun).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'open' }),
    'plugin-keybinding'
  )
  expect(renamed).not.toHaveBeenCalled()
  window.removeEventListener(RENAME_TERMINAL_TAB_EVENT, renamed)
})

it.each(['win32', 'linux'] as const)(
  'restores default Plugins and non-Latin explorer shortcuts on %s',
  (platform) => {
    fixture.platform = platform
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      platform === 'win32' ? 'Windows' : 'Linux'
    )
    fixture.state.keybindings = {}
    const { paragraph } = mount()
    press(paragraph, 'Y', 'KeyY', { ctrlKey: true, shiftKey: true })
    expect(fixture.openSettings).toHaveBeenCalledOnce()
    press(paragraph, 'У', 'KeyE', { ctrlKey: true, shiftKey: true })
    expect(fixture.explorer).toHaveBeenCalledOnce()
  }
)

it('uses logical Latin keys for macOS Control editing ownership on remapped layouts', () => {
  fixture.state.keybindings = { 'sidebar.sleepingWorkspaces.toggle': ['Ctrl+Q'] }
  const { paragraph, rerender } = mount()
  press(paragraph, 'q', 'KeyA', { ctrlKey: true })
  expect(fixture.state.showSleepingWorkspaces).toBe(true)
  fixture.state.keybindings = { 'sidebar.sleepingWorkspaces.toggle': ['Ctrl+A'] }
  rerender()
  expect(press(paragraph, 'a', 'KeyQ', { ctrlKey: true }).defaultPrevented).toBe(false)
  expect(fixture.state.showSleepingWorkspaces).toBe(true)
})

it('still dispatches physical dead-key shortcuts outside a text field', () => {
  fixture.state.keybindings = { 'sidebar.sleepingWorkspaces.toggle': ['Mod+Shift+BracketRight'] }
  mount()
  press(document.body, 'Dead', 'BracketRight', { metaKey: true, shiftKey: true })
  expect(fixture.state.showSleepingWorkspaces).toBe(true)
})

it('keeps send, steer, clipboard and selection keys with the real composer despite colliding app/plugin bindings', () => {
  fixture.state.keybindings = {
    'sidebar.sleepingWorkspaces.toggle': [
      'Mod+Enter',
      'Mod+Shift+Enter',
      'Mod+Z',
      'Mod+Shift+ArrowUp'
    ]
  }
  fixture.plugins = [
    {
      pluginKey: 'fixture',
      pluginName: 'Fixture',
      id: 'send',
      title: 'Send',
      context: 'global',
      handler: { type: 'built-in', action: 'view.tasks' },
      keybindings: [{ key: 'Mod+Enter', when: 'global' }]
    }
  ]
  const { editor, paragraph } = mount()
  press(paragraph, 'Enter', 'Enter', { metaKey: true })
  expect(fixture.send).toHaveBeenCalledExactlyOnceWith({ alternate: true })
  press(paragraph, 'Enter', 'Enter', { metaKey: true, shiftKey: true })
  expect(fixture.steer).toHaveBeenCalledOnce()
  expect(press(paragraph, 'z', 'KeyZ', { metaKey: true }).defaultPrevented).toBe(false)
  expect(
    press(paragraph, 'ArrowUp', 'ArrowUp', { metaKey: true, shiftKey: true }).defaultPrevented
  ).toBe(false)
  expect(fixture.state.showSleepingWorkspaces).toBe(false)
  expect(fixture.pluginRun).not.toHaveBeenCalled()
  expect(editor.textContent).toBe('draft stays')
})

it('protects ordinary fields, shortcut recorders, floating panels and composing gestures', () => {
  const { editor, paragraph, rerender } = mount()
  const field = document.createElement('input')
  document.body.append(field)
  expect(press(field, '\\', 'Backslash', { metaKey: true }).defaultPrevented).toBe(false)
  editor.setAttribute('data-shortcut-recorder-active', '')
  press(paragraph, '\\', 'Backslash', { metaKey: true })
  editor.removeAttribute('data-shortcut-recorder-active')
  fixture.floating = true
  press(paragraph, '\\', 'Backslash', { metaKey: true })
  fixture.floating = false
  press(paragraph, '\\', 'Backslash', { metaKey: true, isComposing: true })
  expect(fixture.state.showSleepingWorkspaces).toBe(false)
  fixture.state.keybindings = { 'sidebar.sleepingWorkspaces.toggle': ['DoubleTap+Ctrl'] }
  rerender()
  press(paragraph, 'Control', 'ControlLeft', { ctrlKey: true, isComposing: true })
  fireEvent.keyUp(paragraph, { key: 'Control', code: 'ControlLeft', isComposing: true })
  press(paragraph, 'Control', 'ControlLeft', { ctrlKey: true })
  expect(fixture.state.showSleepingWorkspaces).toBe(false)
  fireEvent.keyUp(paragraph, { key: 'Control', code: 'ControlLeft' })
  press(paragraph, 'Control', 'ControlLeft', { ctrlKey: true })
  expect(fixture.state.showSleepingWorkspaces).toBe(true)
})

it('carries native default deletion through the IPC bridge and preserves composition and text-producing overrides', () => {
  vi.stubGlobal('process', { ...process, platform: 'linux' })
  fixture.platform = 'linux'
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Linux')
  const { editor, paragraph, rerender } = mount()
  const row = document.createElement('div')
  row.dataset.worktreeId = 'wt-1'
  row.dataset.worktreeHostIdentity = 'local|wt-1'
  const query = document.querySelectorAll.bind(document)
  vi.spyOn(document, 'querySelectorAll').mockImplementation((selector) =>
    selector.endsWith(':hover') ? query('[data-hovered-fixture]') : query(selector)
  )
  row.setAttribute('data-hovered-fixture', '')
  document.body.append(row)
  const subscribe = () => noop
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real IPC bridge only subscribes to UI events, supplied by this proxy.
  window.api = {
    ui: new Proxy(
      {},
      {
        get: (_target, key) =>
          key === 'onDeleteCurrentWorkspace'
            ? (listener: () => void) => {
                fixture.deleteIpc = listener
                return noop
              }
            : subscribe
      }
    )
  } as never
  const unsubs: (() => void)[] = []
  registerWorkspaceShortcutIpcBridge(unsubs)
  const send = vi.fn((channel: string) => {
    if (channel === 'ui:deleteCurrentWorkspace') {
      fixture.deleteIpc()
    }
  })
  const mainWindow = {
    on: noop,
    webContents: {
      on: (name: string, handler: (...args: any[]) => void) => fixture.handlers.set(name, handler),
      send
    }
  }
  const focus = {
    isShortcutRecorderFocused: () => false,
    isTerminalInputFocused: () => false,
    isFloatingTerminalInputFocused: () => false,
    isFloatingPanelFocused: () => false,
    isMarkdownEditorFocused: () => false
  }
  installMainWindowShortcutRouting({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: routing uses only the on/send surface supplied by this native event fixture.
    mainWindow: mainWindow as unknown as BrowserWindow,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: routing reads only the focus predicates supplied by this fixture.
    focus: focus as MainWindowFocusLifecycle,
    store: null,
    opts: { getKeybindings: () => fixture.state.keybindings }
  })
  const input: Input = {
    type: 'keyDown',
    location: 0,
    modifiers: [],
    key: 'Backspace',
    code: 'Backspace',
    meta: process.platform === 'darwin',
    control: process.platform !== 'darwin',
    alt: false,
    shift: true,
    isAutoRepeat: false,
    isComposing: false
  }
  const dispatch = (value: Input) => {
    const preventDefault = vi.fn()
    fixture.handlers.get('before-input-event')!({ preventDefault }, value)
    return preventDefault
  }
  expect(dispatch({ ...input, isComposing: true })).not.toHaveBeenCalled()
  fixture.state.keybindings = { 'workspace.delete': ['Alt+E'] }
  expect(
    dispatch({
      ...input,
      key: 'Dead',
      code: 'KeyE',
      meta: false,
      control: false,
      alt: true,
      shift: false
    })
  ).not.toHaveBeenCalled()
  fixture.state.keybindings = { 'workspace.delete': ['Mod+Enter'] }
  expect(dispatch({ ...input, key: 'Enter', code: 'Enter', shift: false })).not.toHaveBeenCalled()
  fixture.state.keybindings = { 'workspace.delete': ['Mod+A'] }
  expect(dispatch({ ...input, key: 'a', code: 'KeyQ', shift: false })).not.toHaveBeenCalled()
  expect(fixture.deleteWorktree).not.toHaveBeenCalled()
  fixture.state.keybindings = { 'workspace.delete': ['Ctrl+Shift+Q'] }
  expect(dispatch({ ...input, key: 'Q', code: 'KeyA' })).toHaveBeenCalledOnce()
  expect(fixture.deleteWorktree).toHaveBeenCalledExactlyOnceWith('wt-1', {
    expectedInstanceId: 'instance',
    expectedHostId: 'local'
  })
  fixture.deleteWorktree.mockClear()
  rerender()
  expect(press(paragraph, 'Q', 'KeyA', { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(
    true
  )
  expect(fixture.deleteWorktree).toHaveBeenCalledExactlyOnceWith('wt-1', {
    expectedInstanceId: 'instance',
    expectedHostId: 'local'
  })
  fixture.deleteWorktree.mockClear()
  fixture.state.keybindings = { 'workspace.delete': ['Ctrl+Z'] }
  rerender()
  expect(dispatch({ ...input, key: 'я', code: 'KeyZ', shift: false })).not.toHaveBeenCalled()
  expect(press(paragraph, 'я', 'KeyZ', { ctrlKey: true }).defaultPrevented).toBe(false)
  expect(fixture.deleteWorktree).not.toHaveBeenCalled()
  fixture.state.keybindings = {}
  expect(dispatch(input)).toHaveBeenCalled()
  expect(fixture.deleteWorktree).toHaveBeenCalledExactlyOnceWith('wt-1', {
    expectedInstanceId: 'instance',
    expectedHostId: 'local'
  })
  fixture.deleteWorktree.mockClear()
  fixture.state.keybindings = { 'workspace.delete': ['DoubleTap+Ctrl'] }
  const tap = (isComposing = false) => {
    const modifier = {
      ...input,
      key: 'Control',
      code: 'ControlLeft',
      meta: false,
      control: true,
      shift: false,
      isComposing
    }
    dispatch(modifier)
    dispatch({ ...modifier, type: 'keyUp', control: false })
  }
  tap(true)
  tap()
  expect(fixture.deleteWorktree).not.toHaveBeenCalled()
  tap(true)
  tap()
  tap(true)
  expect(fixture.deleteWorktree).not.toHaveBeenCalled()
  tap()
  tap()
  expect(fixture.deleteWorktree).toHaveBeenCalledExactlyOnceWith('wt-1', {
    expectedInstanceId: 'instance',
    expectedHostId: 'local'
  })
  fixture.deleteWorktree.mockClear()
  fixture.state.keybindings = {}
  const field = document.createElement('input')
  document.body.append(field)
  field.focus()
  dispatch(input)
  expect(fixture.deleteWorktree).not.toHaveBeenCalled()
  editor.focus()
  fixture.state.activeModal = 'delete-worktree'
  dispatch(input)
  expect(fixture.deleteWorktree).not.toHaveBeenCalled()
  unsubs.forEach((unsub) => unsub())
})
