/* eslint-disable max-lines -- Why: these tests mock the floating panel's
 * React/store environment directly so close and bootstrap behavior can be
 * asserted without mounting the full Electron renderer. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { BrowserTab, Tab, TabGroup, TerminalTab } from '../../../../shared/types'
import type { OpenFile } from '@/store/slices/editor'
import { createUntitledMarkdownFile } from '@/lib/create-untitled-markdown'

type EffectCallback = () => void | (() => void)

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

type FloatingPanelStoreState = {
  tabsByWorktree: Record<string, TerminalTab[]>
  browserTabsByWorktree: Record<string, BrowserTab[]>
  browserPagesByWorkspace: Record<string, unknown[]>
  groupsByWorktree: Record<string, TabGroup[]>
  unifiedTabsByWorktree: Record<string, Tab[]>
  openFiles: OpenFile[]
  activeTabIdByWorktree: Record<string, string | null>
  expandedPaneByTabId: Record<string, boolean>
  createTab: (
    worktreeId: string,
    groupId?: string,
    shellOverride?: string,
    options?: { activate?: boolean; pendingActivationSpawn?: boolean; initialPtyId?: string }
  ) => TerminalTab
  createBrowserTab: (
    worktreeId: string,
    url: string,
    options?: {
      activate?: boolean
      focusAddressBar?: boolean
      sessionProfileId?: string | null
      title?: string
      targetGroupId?: string
    }
  ) => BrowserTab
  closeTab: (tabId: string) => void
  closeBrowserTab: (tabId: string) => void
  closeFile: (fileId: string) => void
  markFileDirty: (fileId: string, dirty: boolean) => void
  activateTab: (tabId: string) => void
  setActiveTab: (tabId: string) => void
  setTabCustomTitle: (tabId: string, title: string | null) => void
  setTabColor: (tabId: string, color: string | null) => void
  setTabPaneExpanded: (tabId: string, expanded: boolean) => void
  pinFile: (fileId: string, tabId?: string) => void
  openFile: (file: unknown, options?: unknown) => void
  browserDefaultUrl: string
  tabBarOrderByWorktree: Record<string, string[]>
  settings: { activeRuntimeEnvironmentId?: string | null; floatingTerminalCwd?: string }
}

const hookRuntime = vi.hoisted(() => ({
  effects: [] as EffectCallback[],
  index: 0,
  values: [] as unknown[]
}))

const storeBox = vi.hoisted(() => ({
  state: null as unknown
}))

const mocks = vi.hoisted(() => ({
  activateTab: vi.fn(),
  activateWebRuntimeSessionTab: vi.fn(),
  closeBrowserTab: vi.fn(),
  closeWebRuntimeSessionTab: vi.fn(),
  closeFile: vi.fn(),
  closeTab: vi.fn(),
  createBrowserTab: vi.fn(),
  createTab: vi.fn(),
  createWebRuntimeSessionBrowserTab: vi.fn(),
  createWebRuntimeSessionTerminal: vi.fn(),
  focusTerminalTabSurface: vi.fn(),
  getFloatingMarkdownDirectory: vi.fn(),
  getFloatingTerminalCwd: vi.fn(),
  getInstallStatus: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(),
  markFileDirty: vi.fn(),
  openFile: vi.fn(),
  pickFloatingMarkdownDocument: vi.fn(),
  pinFile: vi.fn(),
  setActiveTab: vi.fn(),
  setTabColor: vi.fn(),
  setTabCustomTitle: vi.fn(),
  setTabPaneExpanded: vi.fn()
}))

const saveDialogBox = vi.hoisted(() => ({
  fileId: null as string | null
}))

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    useCallback: <T,>(callback: T) => callback,
    useEffect: (effect: EffectCallback) => {
      hookRuntime.effects.push(effect)
    },
    useMemo: <T,>(factory: () => T) => factory(),
    useRef: <T,>(initialValue: T) => {
      const index = hookRuntime.index
      hookRuntime.index += 1
      if (hookRuntime.values[index] === undefined) {
        hookRuntime.values[index] = { current: initialValue }
      }
      return hookRuntime.values[index] as { current: T }
    },
    useState: <T,>(initialValue: T | (() => T)) => {
      const index = hookRuntime.index
      hookRuntime.index += 1
      if (hookRuntime.values[index] === undefined) {
        hookRuntime.values[index] =
          typeof initialValue === 'function' ? (initialValue as () => T)() : initialValue
      }
      const setValue = (nextValue: T | ((current: T) => T)): void => {
        hookRuntime.values[index] =
          typeof nextValue === 'function'
            ? (nextValue as (current: T) => T)(hookRuntime.values[index] as T)
            : nextValue
      }
      return [hookRuntime.values[index] as T, setValue] as const
    }
  }
})

vi.mock('@/store', () => {
  const useAppStore = Object.assign(
    (selector: (state: FloatingPanelStoreState) => unknown) =>
      selector(storeBox.state as FloatingPanelStoreState),
    {
      getState: () => storeBox.state as FloatingPanelStoreState
    }
  )
  return { useAppStore }
})

vi.mock('@/components/tab-bar/TabBar', () => ({
  default: function TabBar() {
    return null
  }
}))

vi.mock('@/components/terminal-pane/TerminalPane', () => ({
  default: function TerminalPane() {
    return null
  }
}))

vi.mock('@/components/browser-pane/BrowserPane', () => ({
  default: function BrowserPane() {
    return null
  }
}))

vi.mock('@/components/editor/EditorPanel', () => ({
  default: function EditorPanel() {
    return null
  }
}))

vi.mock('@/components/ui/button', () => ({
  Button: function Button() {
    return null
  }
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: function Dialog(props: { children?: unknown }) {
    return props.children
  },
  DialogContent: function DialogContent(props: { children?: unknown }) {
    return props.children
  },
  DialogDescription: function DialogDescription(props: { children?: unknown }) {
    return props.children
  },
  DialogFooter: function DialogFooter(props: { children?: unknown }) {
    return props.children
  },
  DialogHeader: function DialogHeader(props: { children?: unknown }) {
    return props.children
  },
  DialogTitle: function DialogTitle(props: { children?: unknown }) {
    return props.children
  }
}))

vi.mock('@/components/terminal/useTerminalSaveDialog', () => ({
  useTerminalSaveDialog: () => ({
    handleSaveDialogCancel: () => {
      saveDialogBox.fileId = null
    },
    handleSaveDialogDiscard: () => {
      if (saveDialogBox.fileId) {
        mocks.markFileDirty(saveDialogBox.fileId, false)
        mocks.closeFile(saveDialogBox.fileId)
      }
      saveDialogBox.fileId = null
    },
    handleSaveDialogSave: () => {
      saveDialogBox.fileId = null
    },
    requestCloseFile: (fileId: string) => {
      const file = (storeBox.state as FloatingPanelStoreState).openFiles.find(
        (candidate) => candidate.id === fileId
      )
      if (file?.isDirty) {
        saveDialogBox.fileId = fileId
        return
      }
      mocks.closeFile(fileId)
    },
    saveDialogFile: saveDialogBox.fileId
      ? ((storeBox.state as FloatingPanelStoreState).openFiles.find(
          (file) => file.id === saveDialogBox.fileId
        ) ?? null)
      : null,
    saveDialogFileId: saveDialogBox.fileId
  })
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  activateWebRuntimeSessionTab: mocks.activateWebRuntimeSessionTab,
  closeWebRuntimeSessionTab: mocks.closeWebRuntimeSessionTab,
  createWebRuntimeSessionBrowserTab: mocks.createWebRuntimeSessionBrowserTab,
  createWebRuntimeSessionTerminal: mocks.createWebRuntimeSessionTerminal,
  isWebRuntimeSessionActive: mocks.isWebRuntimeSessionActive
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: () => undefined
}))

vi.mock('@/lib/create-untitled-markdown', () => ({
  createUntitledMarkdownFile: vi.fn()
}))

vi.mock('@/lib/ipc-error', () => ({
  extractIpcErrorMessage: (_err: unknown, fallback: string) => fallback
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn() }
}))

vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: mocks.focusTerminalTabSurface
}))

vi.mock('@/lib/orchestration-setup-state', () => ({
  ORCHESTRATION_SETUP_DISMISSED_STORAGE_KEY: 'floating-terminal-test-dismissed',
  ORCHESTRATION_SETUP_STATE_EVENT: 'floating-terminal-test-setup-state',
  hasOrchestrationSetupMarker: vi.fn(() => true),
  isOrchestrationSetupDismissed: vi.fn(() => false),
  notifyOrchestrationSetupStateChanged: vi.fn()
}))

vi.mock('./FloatingTerminalOrchestrationDialog', () => ({
  FloatingTerminalOrchestrationDialog: function FloatingTerminalOrchestrationDialog() {
    return null
  }
}))

vi.mock('./FloatingTerminalResizeHandles', () => ({
  FloatingTerminalResizeHandles: function FloatingTerminalResizeHandles() {
    return null
  }
}))

vi.mock('./FloatingTerminalToggleButton', () => ({
  FloatingTerminalToggleButton: function FloatingTerminalToggleButton() {
    return null
  }
}))

vi.mock('./FloatingTerminalWindowControls', () => ({
  FloatingTerminalWindowControls: function FloatingTerminalWindowControls() {
    return null
  }
}))

vi.mock('./floating-terminal-panel-bounds', () => ({
  clampFloatingTerminalBounds: (bounds: unknown) => bounds,
  getDefaultFloatingTerminalBounds: () => ({ height: 480, left: 20, top: 20, width: 720 }),
  getMaximizedFloatingTerminalBounds: () => ({ height: 700, left: 0, top: 0, width: 1000 })
}))

function makeTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: overrides.id ?? 'tab-1',
    ptyId: overrides.ptyId ?? null,
    worktreeId: overrides.worktreeId ?? FLOATING_TERMINAL_WORKTREE_ID,
    title: overrides.title ?? 'Terminal',
    customTitle: overrides.customTitle ?? null,
    color: overrides.color ?? null,
    sortOrder: overrides.sortOrder ?? 0,
    createdAt: overrides.createdAt ?? 0,
    ...overrides
  }
}

function makeFile(overrides: Partial<OpenFile> = {}): OpenFile {
  const id = overrides.id ?? 'file-1'
  return {
    id,
    filePath: overrides.filePath ?? `/tmp/orca/${id}.md`,
    relativePath: overrides.relativePath ?? `${id}.md`,
    worktreeId: overrides.worktreeId ?? FLOATING_TERMINAL_WORKTREE_ID,
    language: overrides.language ?? 'markdown',
    isDirty: overrides.isDirty ?? false,
    mode: overrides.mode ?? 'edit',
    ...overrides
  }
}

function setFloatingTabs(tabs: TerminalTab[]): void {
  const state = storeBox.state as FloatingPanelStoreState
  const groupId = 'floating-group'
  const unifiedTabs = tabs.map<Tab>((tab, index) => ({
    id: tab.id,
    entityId: tab.id,
    groupId,
    worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
    contentType: 'terminal',
    label: tab.title,
    customLabel: tab.customTitle,
    color: tab.color,
    sortOrder: index,
    createdAt: tab.createdAt
  }))
  state.tabsByWorktree = { [FLOATING_TERMINAL_WORKTREE_ID]: tabs }
  state.unifiedTabsByWorktree = { [FLOATING_TERMINAL_WORKTREE_ID]: unifiedTabs }
  state.groupsByWorktree = {
    [FLOATING_TERMINAL_WORKTREE_ID]: [
      {
        id: groupId,
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        activeTabId: unifiedTabs[0]?.id ?? null,
        tabOrder: unifiedTabs.map((tab) => tab.id),
        recentTabIds: unifiedTabs.map((tab) => tab.id)
      }
    ]
  }
  state.activeTabIdByWorktree = { [FLOATING_TERMINAL_WORKTREE_ID]: tabs[0]?.id ?? null }
  state.tabBarOrderByWorktree = { [FLOATING_TERMINAL_WORKTREE_ID]: tabs.map((tab) => tab.id) }
}

function setFloatingEditorTabs(files: OpenFile[]): void {
  const state = storeBox.state as FloatingPanelStoreState
  const groupId = 'floating-group'
  const unifiedTabs = files.map<Tab>((file, index) => ({
    id: `tab-${file.id}`,
    entityId: file.id,
    groupId,
    worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
    contentType: 'editor',
    label: file.relativePath,
    customLabel: null,
    color: null,
    sortOrder: index,
    createdAt: index
  }))
  state.openFiles = files
  state.unifiedTabsByWorktree = { [FLOATING_TERMINAL_WORKTREE_ID]: unifiedTabs }
  state.groupsByWorktree = {
    [FLOATING_TERMINAL_WORKTREE_ID]: [
      {
        id: groupId,
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        activeTabId: unifiedTabs[0]?.id ?? null,
        tabOrder: unifiedTabs.map((tab) => tab.id),
        recentTabIds: unifiedTabs.map((tab) => tab.id)
      }
    ]
  }
}

function resetStore(tabs: TerminalTab[] = []): void {
  storeBox.state = {
    tabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: tabs },
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    groupsByWorktree: {},
    unifiedTabsByWorktree: {},
    openFiles: [],
    activeTabIdByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: tabs[0]?.id ?? null },
    expandedPaneByTabId: {},
    activateTab: mocks.activateTab,
    closeBrowserTab: mocks.closeBrowserTab,
    closeFile: mocks.closeFile,
    createTab: mocks.createTab,
    createBrowserTab: mocks.createBrowserTab,
    closeTab: mocks.closeTab,
    markFileDirty: mocks.markFileDirty,
    openFile: mocks.openFile,
    pinFile: mocks.pinFile,
    setActiveTab: mocks.setActiveTab,
    setTabCustomTitle: mocks.setTabCustomTitle,
    setTabColor: mocks.setTabColor,
    setTabPaneExpanded: mocks.setTabPaneExpanded,
    browserDefaultUrl: 'about:blank',
    tabBarOrderByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: tabs.map((tab) => tab.id) },
    settings: { floatingTerminalCwd: '' }
  } satisfies FloatingPanelStoreState
}

function visit(node: unknown, cb: (node: ReactElementLike) => void): void {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return
  }
  if (Array.isArray(node)) {
    node.forEach((entry) => visit(entry, cb))
    return
  }
  const element = node as ReactElementLike
  if (!element.props) {
    return
  }
  cb(element)
  visit(element.props.children, cb)
}

function findByTypeName(node: unknown, typeName: string): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    const candidate =
      typeof entry.type === 'function' || typeof entry.type === 'object'
        ? ((entry.type as { displayName?: string; name?: string }).displayName ??
          (entry.type as { displayName?: string; name?: string }).name ??
          '')
        : entry.type
    if (candidate === typeName) {
      found = entry
    }
  })
  if (!found) {
    throw new Error(`${typeName} not found`)
  }
  return found
}

function findByProp(node: unknown, propName: string): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (entry.props[propName]) {
      found = entry
    }
  })
  if (!found) {
    throw new Error(`${propName} not found`)
  }
  return found
}

function runEffects(): void {
  const effects = hookRuntime.effects.splice(0)
  for (const effect of effects) {
    effect()
  }
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

async function renderPanel(open: boolean, onOpenChange = vi.fn()): Promise<unknown> {
  hookRuntime.index = 0
  const { FloatingTerminalPanel } = await import('./FloatingTerminalPanel')
  return FloatingTerminalPanel({ open, onOpenChange })
}

describe('FloatingTerminalPanel close behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hookRuntime.effects = []
    hookRuntime.index = 0
    hookRuntime.values = []
    saveDialogBox.fileId = null
    resetStore()
    mocks.createTab.mockReturnValue(makeTab({ id: 'created-tab' }))
    mocks.createWebRuntimeSessionBrowserTab.mockResolvedValue(false)
    mocks.createWebRuntimeSessionTerminal.mockResolvedValue(false)
    mocks.getFloatingMarkdownDirectory.mockResolvedValue('/tmp/orca/floating-notes')
    mocks.getFloatingTerminalCwd.mockResolvedValue('/tmp/orca')
    mocks.getInstallStatus.mockResolvedValue({ state: 'installed', pathConfigured: true })
    mocks.isWebRuntimeSessionActive.mockReturnValue(false)
    mocks.pickFloatingMarkdownDocument.mockResolvedValue(null)
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      api: {
        app: {
          getFloatingMarkdownDirectory: mocks.getFloatingMarkdownDirectory,
          getFloatingTerminalCwd: mocks.getFloatingTerminalCwd,
          pickFloatingMarkdownDocument: mocks.pickFloatingMarkdownDocument
        },
        browser: { notifyActiveTabChanged: vi.fn() },
        cli: { getInstallStatus: mocks.getInstallStatus },
        ui: { setFloatingTerminalInputFocused: vi.fn() }
      },
      innerWidth: 1200,
      requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
        callback(0)
        return 1
      }),
      removeEventListener: vi.fn()
    })
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    vi.stubGlobal('HTMLElement', class {})
    vi.stubGlobal('localStorage', { setItem: vi.fn() })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not bootstrap a terminal tab when the panel opens empty', async () => {
    await renderPanel(false)
    runEffects()
    await flushAsyncWork()
    expect(mocks.createTab).not.toHaveBeenCalled()

    await renderPanel(true)
    runEffects()
    await flushAsyncWork()
    expect(mocks.createTab).not.toHaveBeenCalled()

    await renderPanel(true)
    runEffects()
    await flushAsyncWork()
    expect(mocks.createTab).not.toHaveBeenCalled()

    await renderPanel(false)
    runEffects()
    await renderPanel(true)
    runEffects()
    await flushAsyncWork()
    expect(mocks.createTab).not.toHaveBeenCalled()
  })

  it('focuses the empty floating workspace when opened for immediate shortcuts', async () => {
    const element = await renderPanel(true)
    const panel = findByProp(element, 'data-floating-terminal-panel')
    const panelElement = { focus: vi.fn() }
    ;(panel.props.ref as { current: unknown }).current = panelElement

    runEffects()

    expect(panelElement.focus).toHaveBeenCalledWith({ preventScroll: true })
  })

  it('minimizes the empty floating workspace from the empty state', async () => {
    const onOpenChange = vi.fn()
    const element = await renderPanel(true, onOpenChange)

    const emptyState = findByTypeName(element, 'FloatingTerminalEmptyState')
    ;(emptyState.props.onClose as () => void)()

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(mocks.closeTab).not.toHaveBeenCalled()
    expect(mocks.closeFile).not.toHaveBeenCalled()
    expect(mocks.closeBrowserTab).not.toHaveBeenCalled()
  })

  it('shows the empty state when only stale unified tabs remain', async () => {
    const state = storeBox.state as FloatingPanelStoreState
    const staleTab = makeTab({ id: 'stale-tab' })
    setFloatingTabs([staleTab])
    state.tabsByWorktree = { [FLOATING_TERMINAL_WORKTREE_ID]: [] }
    state.activeTabIdByWorktree = { [FLOATING_TERMINAL_WORKTREE_ID]: null }

    const element = await renderPanel(true)
    const emptyState = findByTypeName(element, 'FloatingTerminalEmptyState')

    expect(emptyState).toBeTruthy()
  })

  it('creates new floating terminal tabs without globally activating createTab', async () => {
    setFloatingTabs([makeTab({ id: 'tab-1' })])

    const element = await renderPanel(true)
    const tabBar = findByTypeName(element, 'TabBar')
    ;(tabBar.props.onNewTerminalTab as () => void)()
    await flushAsyncWork()

    expect(mocks.createTab).toHaveBeenCalledWith(
      FLOATING_TERMINAL_WORKTREE_ID,
      'floating-group',
      undefined,
      { activate: false }
    )
    expect(mocks.activateTab).toHaveBeenCalledWith('created-tab')
    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith('created-tab')
  })

  it('routes titlebar Cmd+T to the floating workspace', async () => {
    setFloatingTabs([makeTab({ id: 'tab-1' })])
    const element = await renderPanel(true)
    const panel = findByProp(element, 'data-floating-terminal-panel')
    const titlebarTarget = {
      closest: vi.fn().mockReturnValue({}),
      getAttribute: vi.fn().mockReturnValue(null)
    }
    Object.setPrototypeOf(titlebarTarget, HTMLElement.prototype)
    const preventDefault = vi.fn()

    ;(panel.props.onKeyDownCapture as (event: unknown) => void)({
      altKey: false,
      ctrlKey: false,
      defaultPrevented: false,
      key: 't',
      metaKey: true,
      preventDefault,
      repeat: false,
      shiftKey: false,
      target: titlebarTarget
    })
    await flushAsyncWork()

    expect(preventDefault).toHaveBeenCalledWith()
    expect(mocks.createTab).toHaveBeenCalledWith(
      FLOATING_TERMINAL_WORKTREE_ID,
      'floating-group',
      undefined,
      { activate: false }
    )
    expect(mocks.activateTab).toHaveBeenCalledWith('created-tab')
  })

  it('routes titlebar Cmd+Shift+O to the floating markdown picker', async () => {
    const element = await renderPanel(true)
    const panel = findByProp(element, 'data-floating-terminal-panel')
    const titlebarTarget = {
      closest: vi.fn().mockReturnValue({}),
      getAttribute: vi.fn().mockReturnValue(null)
    }
    Object.setPrototypeOf(titlebarTarget, HTMLElement.prototype)
    const preventDefault = vi.fn()

    ;(panel.props.onKeyDownCapture as (event: unknown) => void)({
      altKey: false,
      ctrlKey: false,
      defaultPrevented: false,
      key: 'o',
      metaKey: true,
      preventDefault,
      repeat: false,
      shiftKey: true,
      target: titlebarTarget
    })
    await flushAsyncWork()

    expect(preventDefault).toHaveBeenCalledWith()
    expect(mocks.pickFloatingMarkdownDocument).toHaveBeenCalledWith()
  })

  it('keeps the empty floating workspace focused after Cmd+W closes the last tab', async () => {
    setFloatingTabs([makeTab({ id: 'tab-1' })])
    const element = await renderPanel(true)
    const panel = findByProp(element, 'data-floating-terminal-panel')
    const panelElement = { contains: vi.fn().mockReturnValue(true), focus: vi.fn() }
    const activeElement = { closest: vi.fn().mockReturnValue(panelElement) }
    const target = { classList: { contains: vi.fn().mockReturnValue(true) }, closest: vi.fn() }
    Object.setPrototypeOf(activeElement, HTMLElement.prototype)
    Object.setPrototypeOf(target, HTMLElement.prototype)
    ;(panel.props.ref as { current: unknown }).current = panelElement
    vi.stubGlobal('document', {
      activeElement,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
    runEffects()
    const keydownListener = vi
      .mocked(window.addEventListener)
      .mock.calls.find(([type]) => type === 'keydown')?.[1] as
      | ((event: unknown) => void)
      | undefined
    if (!keydownListener) {
      throw new Error('keydown listener not registered')
    }

    keydownListener({
      altKey: false,
      ctrlKey: false,
      defaultPrevented: false,
      key: 'w',
      metaKey: true,
      preventDefault: vi.fn(),
      repeat: false,
      shiftKey: false,
      stopImmediatePropagation: vi.fn(),
      stopPropagation: vi.fn(),
      target
    })

    expect(mocks.closeTab).toHaveBeenCalledWith('tab-1')
    expect(panelElement.focus).toHaveBeenCalledWith({ preventScroll: true })
  })

  it('does not steal focus from the next floating tab after Cmd+W closes one of many tabs', async () => {
    setFloatingTabs([makeTab({ id: 'tab-1' }), makeTab({ id: 'tab-2' })])
    const element = await renderPanel(true)
    const panel = findByProp(element, 'data-floating-terminal-panel')
    const panelElement = { contains: vi.fn().mockReturnValue(true), focus: vi.fn() }
    const activeElement = { closest: vi.fn().mockReturnValue(panelElement) }
    const target = { classList: { contains: vi.fn().mockReturnValue(true) }, closest: vi.fn() }
    Object.setPrototypeOf(activeElement, HTMLElement.prototype)
    Object.setPrototypeOf(target, HTMLElement.prototype)
    ;(panel.props.ref as { current: unknown }).current = panelElement
    vi.stubGlobal('document', {
      activeElement,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
    runEffects()
    const keydownListener = vi
      .mocked(window.addEventListener)
      .mock.calls.find(([type]) => type === 'keydown')?.[1] as
      | ((event: unknown) => void)
      | undefined
    if (!keydownListener) {
      throw new Error('keydown listener not registered')
    }

    keydownListener({
      altKey: false,
      ctrlKey: false,
      defaultPrevented: false,
      key: 'w',
      metaKey: true,
      preventDefault: vi.fn(),
      repeat: false,
      shiftKey: false,
      stopImmediatePropagation: vi.fn(),
      stopPropagation: vi.fn(),
      target
    })

    expect(mocks.closeTab).toHaveBeenCalledWith('tab-1')
    expect(panelElement.focus).not.toHaveBeenCalled()
  })

  it('preserves terminal focus when dragging the titlebar from inside the floating panel', async () => {
    setFloatingTabs([makeTab({ id: 'tab-1' })])
    const element = await renderPanel(true)
    const panel = findByProp(element, 'data-floating-terminal-panel')
    const titlebar = findByProp(element, 'data-floating-terminal-shortcut-surface')
    const panelElement = { focus: vi.fn() }
    const activeElement = { closest: vi.fn().mockReturnValue(panelElement) }
    const titlebarTarget = { closest: vi.fn().mockReturnValue(null) }
    Object.setPrototypeOf(activeElement, HTMLElement.prototype)
    Object.setPrototypeOf(titlebarTarget, HTMLElement.prototype)
    ;(panel.props.ref as { current: unknown }).current = panelElement
    vi.stubGlobal('document', { activeElement })

    ;(titlebar.props.onPointerDown as (event: unknown) => void)({
      button: 0,
      clientX: 10,
      clientY: 20,
      currentTarget: { setPointerCapture: vi.fn() },
      pointerId: 1,
      target: titlebarTarget
    })

    expect(panelElement.focus).not.toHaveBeenCalled()
  })

  it('focuses the floating panel for titlebar shortcuts when focus starts outside it', async () => {
    setFloatingTabs([makeTab({ id: 'tab-1' })])
    const element = await renderPanel(true)
    const panel = findByProp(element, 'data-floating-terminal-panel')
    const titlebar = findByProp(element, 'data-floating-terminal-shortcut-surface')
    const panelElement = { focus: vi.fn() }
    const activeElement = { closest: vi.fn().mockReturnValue(null) }
    const titlebarTarget = { closest: vi.fn().mockReturnValue(null) }
    Object.setPrototypeOf(activeElement, HTMLElement.prototype)
    Object.setPrototypeOf(titlebarTarget, HTMLElement.prototype)
    ;(panel.props.ref as { current: unknown }).current = panelElement
    vi.stubGlobal('document', { activeElement })

    ;(titlebar.props.onPointerDown as (event: unknown) => void)({
      button: 0,
      clientX: 10,
      clientY: 20,
      currentTarget: { setPointerCapture: vi.fn() },
      pointerId: 1,
      target: titlebarTarget
    })

    expect(panelElement.focus).toHaveBeenCalledWith({ preventScroll: true })
  })

  it('minimizes the empty floating workspace on Cmd+W after landing focus', async () => {
    const onOpenChange = vi.fn()
    const element = await renderPanel(true, onOpenChange)
    const panel = findByProp(element, 'data-floating-terminal-panel')
    const emptyStateTarget = {
      closest: vi.fn().mockReturnValue({}),
      getAttribute: vi.fn().mockReturnValue(null)
    }
    Object.setPrototypeOf(emptyStateTarget, HTMLElement.prototype)

    ;(panel.props.onKeyDownCapture as (event: unknown) => void)({
      altKey: false,
      ctrlKey: false,
      defaultPrevented: false,
      key: 'w',
      metaKey: true,
      preventDefault: vi.fn(),
      repeat: false,
      shiftKey: false,
      target: emptyStateTarget
    })

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(mocks.closeTab).not.toHaveBeenCalled()
  })

  it('creates floating markdown files in local filesystem mode', async () => {
    setFloatingTabs([makeTab({ id: 'tab-1' })])
    vi.mocked(createUntitledMarkdownFile).mockResolvedValue({
      filePath: '/tmp/orca/floating-notes/untitled.md',
      relativePath: 'untitled.md',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      language: 'markdown',
      isUntitled: true,
      mode: 'edit'
    })

    let element = await renderPanel(true)
    runEffects()
    await flushAsyncWork()
    element = await renderPanel(true)
    const tabBar = findByTypeName(element, 'TabBar')
    ;(tabBar.props.onNewFileTab as () => void)()
    await flushAsyncWork()

    expect(createUntitledMarkdownFile).toHaveBeenCalledWith(
      '/tmp/orca/floating-notes',
      FLOATING_TERMINAL_WORKTREE_ID,
      undefined,
      { activeRuntimeEnvironmentId: null }
    )
    expect(mocks.openFile).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/tmp/orca/floating-notes/untitled.md' }),
      expect.objectContaining({ suppressActiveRuntimeFallback: true })
    )
  })

  it('opens existing markdown documents through the floating picker', async () => {
    setFloatingTabs([makeTab({ id: 'tab-1' })])
    mocks.pickFloatingMarkdownDocument.mockResolvedValue({
      filePath: '/tmp/orca/notes.md',
      relativePath: 'notes.md',
      basename: 'notes.md',
      name: 'notes'
    })

    const element = await renderPanel(true)
    const tabBar = findByTypeName(element, 'TabBar')
    ;(tabBar.props.onOpenFileTab as () => void)()
    await flushAsyncWork()

    expect(mocks.pickFloatingMarkdownDocument).toHaveBeenCalledWith()
    expect(mocks.openFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/tmp/orca/notes.md',
        relativePath: 'notes.md',
        runtimeEnvironmentId: null,
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID
      }),
      expect.objectContaining({ suppressActiveRuntimeFallback: true })
    )
  })

  it('keeps the panel open when the explicit close action removes the last tab', async () => {
    const onOpenChange = vi.fn()
    setFloatingTabs([makeTab({ id: 'tab-1' })])

    const element = await renderPanel(true, onOpenChange)
    const tabBar = findByTypeName(element, 'TabBar')
    ;(tabBar.props.onClose as (tabId: string) => void)('tab-1')

    expect(mocks.closeTab).toHaveBeenCalledWith('tab-1')
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('keeps the panel open when the explicit close action leaves another tab', async () => {
    const onOpenChange = vi.fn()
    setFloatingTabs([
      makeTab({ id: 'tab-1', sortOrder: 0 }),
      makeTab({ id: 'tab-2', sortOrder: 1 })
    ])

    const element = await renderPanel(true, onOpenChange)
    const tabBar = findByTypeName(element, 'TabBar')
    ;(tabBar.props.onClose as (tabId: string) => void)('tab-2')

    expect(mocks.closeTab).toHaveBeenCalledWith('tab-2')
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('keeps PTY exit separate from explicit terminal pane close', async () => {
    const onOpenChange = vi.fn()
    setFloatingTabs([makeTab({ id: 'tab-1' })])

    await renderPanel(true, onOpenChange)
    runEffects()
    await Promise.resolve()
    const element = await renderPanel(true, onOpenChange)
    const terminalPane = findByTypeName(element, 'TerminalPane')

    ;(terminalPane.props.onPtyExit as () => void)()
    expect(mocks.closeTab).toHaveBeenCalledWith('tab-1')
    expect(onOpenChange).not.toHaveBeenCalled()

    mocks.closeTab.mockClear()
    ;(terminalPane.props.onCloseTab as () => void)()
    expect(mocks.closeTab).toHaveBeenCalledWith('tab-1')
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('routes floating terminal create and close through active web runtime sessions', async () => {
    const onOpenChange = vi.fn()
    setFloatingTabs([makeTab({ id: 'tab-1' })])
    ;(storeBox.state as FloatingPanelStoreState).settings.activeRuntimeEnvironmentId = 'runtime-1'
    mocks.isWebRuntimeSessionActive.mockReturnValue(true)
    mocks.createWebRuntimeSessionTerminal.mockResolvedValue(true)

    const element = await renderPanel(true, onOpenChange)
    const tabBar = findByTypeName(element, 'TabBar')
    ;(tabBar.props.onNewTerminalTab as () => void)()
    await flushAsyncWork()

    expect(mocks.createWebRuntimeSessionTerminal).toHaveBeenCalledWith({
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      targetGroupId: 'floating-group',
      command: undefined,
      activate: true,
      selectWorktree: false
    })
    expect(mocks.createTab).not.toHaveBeenCalled()

    ;(tabBar.props.onClose as (tabId: string) => void)('tab-1')
    expect(mocks.closeWebRuntimeSessionTab).toHaveBeenCalledWith({
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      tabId: 'tab-1',
      environmentId: 'runtime-1'
    })
    expect(mocks.closeTab).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('queues dirty editor closes from close-all-files instead of overwriting the dialog id', async () => {
    setFloatingEditorTabs([
      makeFile({ id: 'file-a', isDirty: true }),
      makeFile({ id: 'file-b', isDirty: true })
    ])

    const element = await renderPanel(true)
    const tabBar = findByTypeName(element, 'TabBar')
    ;(tabBar.props.onCloseAllFiles as () => void)()

    expect(saveDialogBox.fileId).toBe('file-a')
    expect(mocks.closeFile).not.toHaveBeenCalledWith('file-a')
    expect(mocks.closeFile).not.toHaveBeenCalledWith('file-b')
  })

  it('queues dirty editor closes from close-others and close-to-right one file at a time', async () => {
    setFloatingEditorTabs([
      makeFile({ id: 'file-a', isDirty: true }),
      makeFile({ id: 'file-b', isDirty: true }),
      makeFile({ id: 'file-c', isDirty: true })
    ])

    const element = await renderPanel(true)
    const tabBar = findByTypeName(element, 'TabBar')
    ;(tabBar.props.onCloseOthers as (tabId: string) => void)('tab-file-b')
    expect(saveDialogBox.fileId).toBe('file-a')

    saveDialogBox.fileId = null
    mocks.closeFile.mockClear()
    hookRuntime.values = []
    const nextElement = await renderPanel(true)
    const nextTabBar = findByTypeName(nextElement, 'TabBar')
    ;(nextTabBar.props.onCloseToRight as (tabId: string) => void)('tab-file-a')
    expect(saveDialogBox.fileId).toBe('file-b')
    expect(mocks.closeFile).not.toHaveBeenCalledWith('file-c')
  })

  it('reads the current tab list for bulk close actions', async () => {
    setFloatingTabs([makeTab({ id: 'old-left' }), makeTab({ id: 'old-keep' })])

    const element = await renderPanel(true)
    const tabBar = findByTypeName(element, 'TabBar')
    setFloatingTabs([
      makeTab({ id: 'new-left', sortOrder: 0 }),
      makeTab({ id: 'new-keep', sortOrder: 1 }),
      makeTab({ id: 'new-right', sortOrder: 2 })
    ])

    ;(tabBar.props.onCloseOthers as (tabId: string) => void)('new-keep')
    expect(mocks.closeTab).toHaveBeenCalledWith('new-left')
    expect(mocks.closeTab).toHaveBeenCalledWith('new-right')
    expect(mocks.closeTab).not.toHaveBeenCalledWith('old-left')

    mocks.closeTab.mockClear()
    ;(tabBar.props.onCloseToRight as (tabId: string) => void)('new-left')
    expect(mocks.closeTab).toHaveBeenCalledWith('new-keep')
    expect(mocks.closeTab).toHaveBeenCalledWith('new-right')
    expect(mocks.closeTab).not.toHaveBeenCalledWith('old-keep')
  })

  it('closes tabs to the right using visible tab order', async () => {
    setFloatingTabs([
      makeTab({ id: 'tab-a', sortOrder: 0 }),
      makeTab({ id: 'tab-b', sortOrder: 1 }),
      makeTab({ id: 'tab-c', sortOrder: 2 })
    ])
    ;(storeBox.state as FloatingPanelStoreState).tabBarOrderByWorktree = {
      [FLOATING_TERMINAL_WORKTREE_ID]: ['tab-c', 'tab-a', 'tab-b']
    }
    ;(storeBox.state as FloatingPanelStoreState).groupsByWorktree[
      FLOATING_TERMINAL_WORKTREE_ID
    ][0].tabOrder = ['tab-c', 'tab-a', 'tab-b']

    const element = await renderPanel(true)
    const tabBar = findByTypeName(element, 'TabBar')
    ;(tabBar.props.onCloseToRight as (tabId: string) => void)('tab-c')

    expect(mocks.closeTab).toHaveBeenCalledWith('tab-a')
    expect(mocks.closeTab).toHaveBeenCalledWith('tab-b')
    expect(mocks.closeTab).not.toHaveBeenCalledWith('tab-c')
  })
})
