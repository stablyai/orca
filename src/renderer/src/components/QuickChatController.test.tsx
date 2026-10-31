// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor
} from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import type * as NewTabRows from '@/lib/new-tab-agent-menu-rows'
import { getDefaultSettings } from '../../../shared/constants'
import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import {
  loadHostStructuredAgents,
  resetHostStructuredAgentsForTests
} from '@/runtime/host-structured-agents'
import { EVERY_AGENT_CHAT } from '../../../shared/native-chat/every-agent-chat.test-fixture'
import { QuickChatController } from './QuickChatController'
import { QuickChatButton, requestQuickChatFromShortcut } from './QuickChatButton'
import { TooltipProvider } from './ui/tooltip'
import { requestQuickChat, QUICK_CHAT_FINISHED_EVENT } from '@/lib/quick-chat-events'
import { useTabAgentMenuLaunch } from './tab-bar/QuickLaunchButton'
import { getLocalAgentPreflightContext } from '@/lib/local-preflight-context'
import { localAgentInventoryContextKey } from '@/lib/local-preflight-context-key'
import fr from '@/i18n/locales/fr.json'
import { noteUserWorkspaceSwitch } from '@/lib/workspace-switch-user-act'
import { RecoverableRenderErrorBoundary } from './error-boundaries/RecoverableRenderErrorBoundary'
import { useGlobalKeybindings } from '@/app-shell/use-global-keybindings'
import { registerWorkspaceShortcutIpcBridge } from '@/hooks/ipc-events/workspace-shortcut-ipc-bridge'
import { uiStateAndMenuCommandsApi } from '../../../preload/api/ui-bridge-state-and-menu-commands'
import { createReposApi } from '@/web/preload-api/web-repositories-api'
import { createWebUiApi } from '@/web/preload-api/web-ui-api'
import { i18n } from '@/i18n/i18n'

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  activate: vi.fn(),
  detect: vi.fn(),
  error: vi.fn(),
  ensure: vi.fn(),
  builds: 0,
  ipc: new Map<string, (...args: unknown[]) => void>()
}))
vi.mock('electron', () => ({
  ipcRenderer: {
    on: (channel: string, listener: (...args: unknown[]) => void) =>
      mocks.ipc.set(channel, listener),
    removeListener: (channel: string) => mocks.ipc.delete(channel),
    invoke: vi.fn()
  }
}))
vi.mock('@/lib/new-tab-agent-menu-rows', async (original) => {
  const actual = await original<typeof NewTabRows>()
  return {
    ...actual,
    buildNewTabAgentMenuRows: (...args: Parameters<typeof actual.buildNewTabAgentMenuRows>) => {
      mocks.builds++
      return actual.buildNewTabAgentMenuRows(...args)
    }
  }
})
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: mocks.launch }))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: mocks.activate }))
vi.mock('@/lib/onboarding-project-checklist', () => ({
  markOnboardingProjectAdded: async () => {}
}))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))
vi.mock('./native-chat/use-native-chat-composer-reveal-focus', () => ({
  captureNativeChatComposerFocusIntent: () => ({ request: vi.fn(), cancel: vi.fn() }),
  requestNativeChatComposerFocus: vi.fn()
}))
vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))
vi.mock('@/i18n/use-ui-language-revision', () => ({ useUiLanguageRevision: () => {} }))
vi.mock('sonner', () => ({
  toast: { error: mocks.error, success: vi.fn(), info: vi.fn(), message: vi.fn() }
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: async () => ({ models: [], seedOptions: {} })
}))

const initial = useAppStore.getInitialState()
const repo = { ...TEST_REPO, id: 'chats', path: 'C:\\data\\chats', kind: 'folder' as const }
const worktree = makeWorktree({
  id: 'chats::C:\\data\\chats',
  repoId: repo.id,
  hostId: 'local',
  path: repo.path
})
function settings(defaultAgent: 'codex' | 'blank' = 'codex') {
  return {
    ...getDefaultSettings('C:\\Users\\qa'),
    defaultTuiAgent: defaultAgent,
    nativeChatProviders: EVERY_AGENT_CHAT,
    localWindowsRuntimeDefault: { kind: 'windows-host' as const }
  }
}
function mount(buttons = true) {
  return render(
    <TooltipProvider>
      <QuickChatController />
      {buttons && (
        <>
          <QuickChatButton landing />
          <QuickChatButton />
        </>
      )}
    </TooltipProvider>
  )
}
beforeEach(() => {
  useAppStore.setState(initial, true)
  vi.clearAllMocks()
  mocks.builds = 0
  mocks.detect.mockResolvedValue(['codex'])
  mocks.ensure.mockResolvedValue({ path: repo.path, repoId: repo.id })
  mocks.launch.mockReturnValue({ surface: { kind: 'host-published' } })
  mocks.activate.mockImplementation((id: string) => {
    useAppStore.setState({
      activeWorktreeId: id,
      activeWorkspaceExecutionHostId: 'local',
      activeView: 'terminal'
    })
    return { primaryTabId: null }
  })
  Object.assign(window, {
    api: {
      platform: { get: () => ({ platform: 'win32' }) },
      preflight: { detectAgents: mocks.detect },
      repos: { ensureQuickChatFolder: mocks.ensure }
    }
  })
  useAppStore.setState({
    repos: [repo],
    settings: settings(),
    worktreesByRepo: { [repo.id]: [worktree] },
    localDetectedAgentIdsByContext: { host: ['codex'] },
    fetchWorktrees: vi.fn<AppState['fetchWorktrees']>().mockResolvedValue(true)
  })
  setLocalRuntimeCapabilitiesForTests([STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY])
})
afterEach(async () => {
  await i18n.changeLanguage('en')
  cleanup()
  vi.restoreAllMocks()
  resetHostStructuredAgentsForTests()
  setLocalRuntimeCapabilitiesForTests(null)
  useAppStore.setState(initial, true)
})

it('preserves Q accepted default actions across their own activations, with separate launch IDs and addressed finish', async () => {
  mount()
  const control = screen.getByRole('button', { name: 'New chat' })
  const finished = vi.fn()
  control.addEventListener(QUICK_CHAT_FINISHED_EVENT, finished)
  await act(async () => {
    for (let q = 0; q < 10; q++) {
      requestQuickChat(control)
    }
  })
  await waitFor(() => expect(mocks.launch).toHaveBeenCalledTimes(10))
  expect(new Set(mocks.launch.mock.calls.map(([input]) => input.requestId)).size).toBe(10)
  expect(new Set(finished.mock.calls.map(([event]) => event.detail)).size).toBe(10)
  expect(mocks.activate).toHaveBeenCalledWith(worktree.id, {
    executionHostId: 'local',
    providesInitialSurface: true
  })
})

it.each(['ensure', 'inventory'])(
  'sticky navigation during %s cancels even departure and return or user selection of Chats',
  async (phase) => {
    let release = () => {}
    if (phase === 'ensure') {
      mocks.ensure.mockReturnValue(
        new Promise((resolve) => {
          release = () => resolve({ path: repo.path, repoId: repo.id })
        })
      )
    } else {
      useAppStore.setState({ localDetectedAgentIdsByContext: {} })
      mocks.detect.mockReturnValue(
        new Promise((resolve) => {
          release = () => resolve(['codex'])
        })
      )
    }
    mount()
    await act(async () => requestQuickChatFromShortcut())
    await act(async () => {
      useAppStore.setState({
        activeWorktreeId: worktree.id,
        activeWorkspaceExecutionHostId: 'local'
      })
      useAppStore.setState({ activeView: 'settings' })
      useAppStore.setState({ activeView: 'terminal', activeWorktreeId: null })
      release()
    })
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
  }
)

it('serves fallback siblings individually, releases only their addressed control obligations and cancels obsolete menus', async () => {
  useAppStore.setState({ repos: [], settings: settings('blank') })
  useAppStore.setState({
    addRepoPath: async () => {
      useAppStore.setState({ repos: [repo] })
      return repo
    }
  })
  mount()
  const landing = document.querySelector<HTMLButtonElement>('[data-quick-chat="landing"]')!
  const sidebar = document.querySelector<HTMLButtonElement>('[data-quick-chat="sidebar"]')!
  const finished = vi.fn()
  landing.addEventListener(QUICK_CHAT_FINISHED_EVENT, finished)
  await act(async () => {
    fireEvent.click(landing)
    fireEvent.click(sidebar)
  })
  await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy())
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  await waitFor(() => expect(finished).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy())
  expect(mocks.launch).not.toHaveBeenCalled()
  await act(async () => useAppStore.setState({ activeView: 'settings' }))
  expect(screen.queryByRole('menu')).toBeNull()
  expect(mocks.launch).not.toHaveBeenCalled()
})

it.each([false, true])(
  'uses local native/WSL inventory and preferences before activation despite a same-ID remote twin (warm=%s)',
  async (warm) => {
    const foreign = { ...repo, executionHostId: 'runtime:peer' }
    const remoteWorktree = { ...worktree, hostId: 'runtime:peer' as const }
    useAppStore.setState({
      repos: [repo, foreign],
      worktreesByRepo: { [repo.id]: [worktree, remoteWorktree] },
      activeWorktreeId: worktree.id,
      activeWorkspaceExecutionHostId: 'runtime:peer',
      detectedAgentIds: ['claude'],
      localDetectedAgentIdsByContext: warm ? { host: ['codex'] } : {}
    })
    mount()
    await act(async () => requestQuickChatFromShortcut())
    await waitFor(() => expect(mocks.launch).toHaveBeenCalledOnce())
    expect(mocks.launch.mock.calls[0][0]).toMatchObject({
      worktreeId: worktree.id,
      selectedExecutionHostId: 'local',
      agent: 'codex',
      requestedSurface: 'chat'
    })
    if (!warm) {
      expect(mocks.detect).toHaveBeenCalledWith(
        expect.not.objectContaining({ wslDistro: 'Ubuntu' })
      )
    }
    const old = renderHook(() =>
      useTabAgentMenuLaunch({ worktreeId: worktree.id, groupId: '', onFocusTerminal: vi.fn() })
    )
    act(() => old.result.current({ kind: 'chat', agent: 'codex', executionHostId: 'local' }))
    const [quick, existing] = mocks.launch.mock.calls.map(([input]) => input)
    expect({
      agent: quick.agent,
      worktreeId: quick.worktreeId,
      requestedSurface: quick.requestedSurface,
      selectedExecutionHostId: quick.selectedExecutionHostId
    }).toEqual({
      agent: existing.agent,
      worktreeId: existing.worktreeId,
      requestedSurface: existing.requestedSurface,
      selectedExecutionHostId: existing.selectedExecutionHostId
    })
  }
)

it('accepts the shortcut without any mounted anchor, then wakes fallback on actual surface remount', async () => {
  useAppStore.setState({ settings: settings('blank') })
  const view = mount(false)
  await act(async () => requestQuickChatFromShortcut())
  expect(mocks.ensure).toHaveBeenCalledOnce()
  expect(screen.queryByRole('menu')).toBeNull()
  view.rerender(
    <TooltipProvider>
      <QuickChatController />
      <QuickChatButton />
    </TooltipProvider>
  )
  await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy())
  expect(mocks.ensure).toHaveBeenCalledOnce()
})

it('hides both web controls and rejects programmatic ingress, and renders a representative translation on desktop', async () => {
  Object.assign(window, { __ORCA_WEB_CLIENT__: true })
  const view = mount()
  expect(screen.queryByRole('button')).toBeNull()
  await act(async () => requestQuickChatFromShortcut())
  expect(mocks.ensure).not.toHaveBeenCalled()
  Object.assign(window, { __ORCA_WEB_CLIENT__: false })
  i18n.addResourceBundle('fr', 'translation', fr, true, true)
  await i18n.changeLanguage('fr')
  useAppStore.setState({ repos: [] })
  view.rerender(
    <TooltipProvider>
      <QuickChatController />
      <QuickChatButton landing />
    </TooltipProvider>
  )
  expect(screen.getByText(fr.quickChat.startChatting)).toBeTruthy()
})

function runtimeProject(kind: 'wsl' | 'windows-host') {
  return {
    id: repo.id,
    name: 'Chats',
    displayName: 'Chats',
    badgeColor: 'blue',
    sourceRepoIds: [repo.id],
    createdAt: 0,
    updatedAt: 0,
    localWindowsRuntimePreference:
      kind === 'wsl'
        ? { kind: 'wsl' as const, distro: 'Ubuntu' }
        : { kind: 'windows-host' as const }
  }
}

it.each([false, true])(
  'uses the destination WSL override through cold/warm menu, picker and final CLI admission (warm=%s)',
  async (warm) => {
    const project = runtimeProject('wsl')
    useAppStore.setState({
      projects: [project],
      activeRepoId: 'other',
      detectedAgentIds: ['codex']
    })
    const context = getLocalAgentPreflightContext(useAppStore.getState(), undefined, undefined, {
      repo,
      worktree
    })
    useAppStore.setState({
      localDetectedAgentIdsByContext: warm
        ? { host: ['codex'], [localAgentInventoryContextKey(context)]: ['claude'] }
        : { host: ['codex'] }
    })
    mocks.detect.mockResolvedValue(['claude'])
    mount()
    await act(async () => requestQuickChatFromShortcut())
    await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy())
    if (!warm) {
      expect(mocks.detect).toHaveBeenCalledWith(expect.objectContaining({ wslDistro: 'Ubuntu' }))
    }
    expect(mocks.launch).not.toHaveBeenCalled()
    fireEvent.click(
      screen
        .getAllByRole('menuitem', { name: /Claude/ })
        .find((row) => !row.hasAttribute('data-disabled'))!
    )
    expect(mocks.launch.mock.calls[0][0]).toMatchObject({
      agent: 'claude',
      selectedExecutionHostId: 'local',
      requestedSurface: 'terminal',
      worktreeId: worktree.id
    })
  }
)

it('abandons obsolete WSL acquisition when the live destination runtime becomes native', async () => {
  useAppStore.setState({ projects: [runtimeProject('wsl')], localDetectedAgentIdsByContext: {} })
  let release = () => {}
  mocks.detect.mockImplementation((context) =>
    context?.wslDistro
      ? new Promise((resolve) => {
          release = () => resolve(['claude'])
        })
      : Promise.resolve(['codex'])
  )
  mount()
  await act(async () => requestQuickChatFromShortcut())
  await waitFor(() =>
    expect(mocks.detect).toHaveBeenCalledWith(expect.objectContaining({ wslDistro: 'Ubuntu' }))
  )
  await act(async () => {
    useAppStore.setState({ projects: [runtimeProject('windows-host')] })
    release()
  })
  await waitFor(() => expect(mocks.launch).toHaveBeenCalledOnce())
  expect(mocks.launch.mock.calls[0][0]).toMatchObject({
    agent: 'codex',
    requestedSurface: 'chat',
    selectedExecutionHostId: 'local'
  })
})

it.each(['add', 'fetch'])(
  'terminates the full intent during %s, then permits a fresh explicit action',
  async (phase) => {
    let release = () => {}
    if (phase === 'add') {
      useAppStore.setState({
        repos: [],
        addRepoPath: () =>
          new Promise((resolve) => {
            release = () => {
              useAppStore.setState({ repos: [repo] })
              resolve(repo)
            }
          })
      })
    } else {
      useAppStore.setState({
        fetchWorktrees: vi.fn<AppState['fetchWorktrees']>().mockReturnValue(
          new Promise<boolean>((resolve) => {
            release = () => resolve(true)
          })
        )
      })
    }
    mount()
    await act(async () => requestQuickChatFromShortcut())
    await act(async () => {
      useAppStore.setState({ activeWorkspaceExecutionHostId: 'runtime:peer' })
      release()
    })
    expect(mocks.launch).not.toHaveBeenCalled()
    useAppStore.setState({
      fetchWorktrees: vi.fn<AppState['fetchWorktrees']>().mockResolvedValue(true)
    })
    await act(async () => requestQuickChatFromShortcut())
    await waitFor(() => expect(mocks.launch).toHaveBeenCalledOnce())
  }
)

it('cancels an explicit user reselect of Chats and finishes two requests from one landing control individually', async () => {
  useAppStore.setState({
    repos: [],
    settings: settings('blank'),
    activeWorktreeId: worktree.id,
    activeWorkspaceExecutionHostId: 'local',
    addRepoPath: async () => {
      useAppStore.setState({ repos: [repo] })
      return repo
    }
  })
  mount()
  const landing = document.querySelector<HTMLButtonElement>('[data-quick-chat="landing"]')!
  const finished = vi.fn()
  landing.addEventListener(QUICK_CHAT_FINISHED_EVENT, finished)
  await act(async () => {
    fireEvent.click(landing)
    fireEvent.click(landing)
  })
  await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy())
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  await waitFor(() => expect(finished).toHaveBeenCalledTimes(1))
  expect(landing.isConnected).toBe(true)
  await act(async () => noteUserWorkspaceSwitch(worktree.id))
  expect(finished).toHaveBeenCalledTimes(2)
  expect(new Set(finished.mock.calls.map(([event]) => event.detail)).size).toBe(2)
  expect(document.querySelector('[data-quick-chat="landing"]')).toBeNull()
})

it.each([10, 100])(
  'keeps one real observation with linear model work for %s pending actions and isolates a peer publication',
  async (q) => {
    const subscribe = vi.spyOn(useAppStore, 'subscribe')
    useAppStore.setState({ localDetectedAgentIdsByContext: {} })
    let release = () => {}
    mocks.detect.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve(['codex'])
      })
    )
    mount()
    for (let i = 0; i < q; i++) {
      await act(async () => requestQuickChatFromShortcut())
    }
    expect(mocks.detect).toHaveBeenCalledOnce()
    expect(subscribe.mock.calls.length).toBeLessThan(q * 3 + 20)
    expect(mocks.builds).toBeLessThan(q * 4 + 10)
    const before = mocks.builds
    Object.assign(window.api, {
      runtime: {
        call: async () => ({
          id: 'agents',
          ok: true,
          result: { agents: [{ agent: 'pi', capabilities: {} }] }
        })
      }
    })
    await act(async () =>
      loadHostStructuredAgents(
        'runtime:peer',
        [STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY],
        'peer-runtime'
      )
    )
    expect(mocks.builds).toBe(before)
    await act(async () => release())
    await waitFor(() => expect(mocks.launch).toHaveBeenCalledTimes(q))
    expect(subscribe.mock.calls.length).toBeLessThan(q * 4 + 30)
  }
)

it('settles a real failed local catalog publication into the existing fallback instead of holding forever', async () => {
  setLocalRuntimeCapabilitiesForTests([
    STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
    STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
  ])
  Object.assign(window.api, {
    runtime: {
      call: async () => ({
        id: 'agents',
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'fixture failure' }
      })
    }
  })
  useAppStore.setState({ settings: settings('blank') })
  mount()
  await act(async () => requestQuickChatFromShortcut())
  await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy())
  fireEvent.click(screen.getByRole('menuitem', { name: /Codex/ }))
  expect(mocks.launch).toHaveBeenCalledOnce()
})

it.each([false, true])(
  'accepts before revealing Settings/collapsed sidebar and survives contained-sidebar-error recovery (fallback=%s)',
  async (fallback) => {
    useAppStore.setState({
      activeView: 'settings',
      sidebarOpen: false,
      settings: settings(fallback ? 'blank' : 'codex')
    })
    function Sidebar({ broken }: { broken: boolean }) {
      if (broken) {
        throw new Error('contained sidebar fixture')
      }
      return <QuickChatButton />
    }
    const view = render(
      <TooltipProvider>
        <QuickChatController />
        <RecoverableRenderErrorBoundary
          boundaryId="sidebar"
          surface="sidebar"
          reportAsCrash={false}
          resetKey="terminal"
        >
          <Sidebar broken />
        </RecoverableRenderErrorBoundary>
      </TooltipProvider>
    )
    await act(async () => requestQuickChatFromShortcut())
    expect(useAppStore.getState()).toMatchObject({ activeView: 'terminal', sidebarOpen: true })
    if (fallback) {
      expect(mocks.launch).not.toHaveBeenCalled()
      view.rerender(
        <TooltipProvider>
          <QuickChatController />
          <RecoverableRenderErrorBoundary
            boundaryId="sidebar"
            surface="sidebar"
            reportAsCrash={false}
            resetKey="recovered"
          >
            <Sidebar broken={false} />
          </RecoverableRenderErrorBoundary>
        </TooltipProvider>
      )
      await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy())
      fireEvent.click(screen.getByRole('menuitem', { name: /Codex/ }))
    }
    await waitFor(() => expect(mocks.launch).toHaveBeenCalledOnce())
    expect(mocks.ensure).toHaveBeenCalledOnce()
  }
)

it('finishes activation refusal and launch failure exactly as the existing launch seam, allowing re-entry', async () => {
  mount()
  mocks.activate.mockReturnValueOnce(false)
  await act(async () => requestQuickChatFromShortcut())
  expect(mocks.launch).not.toHaveBeenCalled()
  expect(mocks.error).toHaveBeenCalledOnce()
  mocks.launch.mockReturnValueOnce(null)
  await act(async () => requestQuickChatFromShortcut())
  expect(mocks.launch).toHaveBeenCalledOnce()
  expect(mocks.error).toHaveBeenCalledTimes(2)
  const failure = mocks.error.mock.calls.at(-1)
  const existing = renderHook(() =>
    useTabAgentMenuLaunch({ worktreeId: worktree.id, groupId: '', onFocusTerminal: vi.fn() })
  )
  mocks.launch.mockReturnValueOnce(null)
  act(() => existing.result.current({ kind: 'chat', agent: 'codex', executionHostId: 'local' }))
  expect(mocks.error.mock.calls.at(-1)).toEqual(failure)
  await act(async () => requestQuickChatFromShortcut())
  expect(mocks.launch).toHaveBeenCalledTimes(3)
})

it('delivers native/guest IPC through the real preload subscription and renderer bridge to controller settlement, and unsubscribes', async () => {
  Object.assign(window.api, {
    ui: { ...uiStateAndMenuCommandsApi, onToggleStatusBar: () => () => {} }
  })
  const unsubs: (() => void)[] = []
  registerWorkspaceShortcutIpcBridge(unsubs)
  mount()
  await act(async () => mocks.ipc.get('ui:quickStartChat')?.({}))
  expect(mocks.launch).toHaveBeenCalledOnce()
  unsubs.forEach((stop) => stop())
  expect(mocks.ipc.has('ui:quickStartChat')).toBe(false)
  const web = createWebUiApi()
  const callback = vi.fn()
  web.onQuickStartChat(callback)()
  expect(callback).not.toHaveBeenCalled()
  await expect(createReposApi().ensureQuickChatFolder()).rejects.toThrow(
    'unavailable in paired web'
  )
})

it('runs the production renderer dispatcher from floating xterm focus before that surface yields, respecting repeats and recorder/composition', async () => {
  useAppStore.setState({ keybindings: { 'chat.quickStart': ['Mod+Shift+Q'] } })
  function Keys() {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this dispatch fixture supplies every layout field read by useGlobalKeybindings.
    const layout = {
      activeView: 'terminal',
      creationLayoutActive: false,
      workspaceChromeActive: true
    } as Parameters<typeof useGlobalKeybindings>[0]['layout']
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only these floating focus/command facts are read by this hook.
    const floatingWorkspace = {
      enabled: true,
      open: true,
      visibleTabCount: 1,
      openMaximized: vi.fn(),
      setOpenWithFocus: vi.fn(),
      cancelReturnFocusFrame: vi.fn(),
      shouldMountPanel: true,
      showToggleButton: true,
      tourInteractionSnapshotRef: { current: null }
    } as Parameters<typeof useGlobalKeybindings>[0]['floatingWorkspace']
    useGlobalKeybindings({ layout, floatingWorkspace })
    return (
      <div data-floating-terminal-panel>
        <textarea className="xterm-helper-textarea" data-testid="xterm" />
      </div>
    )
  }
  const view = render(
    <>
      <QuickChatController />
      <Keys />
    </>
  )
  const terminal = screen.getByTestId('xterm')
  const send = (extra = {}) =>
    fireEvent.keyDown(terminal, { key: 'q', code: 'KeyQ', ctrlKey: true, shiftKey: true, ...extra })
  await act(async () => send())
  expect(mocks.launch).toHaveBeenCalledOnce()
  await act(async () => {
    send({ repeat: true })
    send({ isComposing: true })
    terminal.setAttribute('data-shortcut-recorder-active', 'true')
    send()
  })
  expect(mocks.launch).toHaveBeenCalledOnce()
  terminal.removeAttribute('data-shortcut-recorder-active')
  await act(async () => send())
  expect(mocks.launch).toHaveBeenCalledTimes(2)
  view.unmount()
  await act(async () => send())
  expect(mocks.launch).toHaveBeenCalledTimes(2)
})

it('retires removed in-flight preparation and allows a new identity before the stale fetch returns', async () => {
  let release = () => {}
  const fresh = { ...repo, id: 'fresh-chats' }
  const freshWorktree = { ...worktree, id: 'fresh-workspace', repoId: fresh.id }
  const addRepoPath = async () => {
    useAppStore.setState({ repos: [fresh], worktreesByRepo: { [fresh.id]: [freshWorktree] } })
    return fresh
  }
  useAppStore.setState({
    addRepoPath,
    fetchWorktrees: vi.fn<AppState['fetchWorktrees']>().mockReturnValue(
      new Promise<boolean>((resolve) => {
        release = () => resolve(true)
      })
    )
  })
  mount()
  await act(async () => requestQuickChatFromShortcut())
  await act(async () => useAppStore.setState({ repos: [], worktreesByRepo: {} }))
  mocks.ensure.mockResolvedValue({ path: repo.path, repoId: fresh.id })
  useAppStore.setState({
    fetchWorktrees: vi.fn<AppState['fetchWorktrees']>().mockResolvedValue(true)
  })
  await act(async () => requestQuickChatFromShortcut())
  expect(mocks.launch).toHaveBeenCalledOnce()
  expect(mocks.launch.mock.calls[0][0].worktreeId).toBe(freshWorktree.id)
  await act(async () => release())
  expect(mocks.launch).toHaveBeenCalledOnce()
  expect(useAppStore.getState().repos).toEqual([fresh])
})

it('waits for earlier accepted fallback preparation and executes distinct choices for siblings in acceptance order', async () => {
  let release = () => {}
  mocks.ensure.mockReturnValueOnce(
    new Promise((resolve) => {
      release = () => resolve({ path: repo.path, repoId: repo.id })
    })
  )
  useAppStore.setState({ settings: settings('blank') })
  mount()
  const control = screen.getByRole('button', { name: 'New chat' })
  const finished: string[] = []
  control.addEventListener(QUICK_CHAT_FINISHED_EVENT, (event) => {
    if (event instanceof CustomEvent) {
      finished.push(event.detail)
    }
  })
  let first: string | null = null
  let second: string | null = null
  await act(async () => {
    first = requestQuickChat(control)
    second = requestQuickChat(control)
  })
  expect(screen.queryByRole('menu')).toBeNull()
  await act(async () => release())
  await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy())
  fireEvent.click(screen.getByRole('menuitem', { name: /Codex/ }))
  await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy())
  expect(finished).toEqual([first])
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  await waitFor(() => expect(finished).toEqual([first, second]))
  expect(mocks.launch).toHaveBeenCalledOnce()
})

it.each([false, true])(
  'observes native Chats independently of a locally focused WSL project and unselected same-ID twins (warm=%s)',
  async (warm) => {
    const otherRepo = { ...repo, id: 'wsl-project', path: 'C:\\other' }
    const other = { ...worktree, id: 'other-workspace', repoId: otherRepo.id, path: otherRepo.path }
    const project = { ...runtimeProject('wsl'), id: otherRepo.id, sourceRepoIds: [otherRepo.id] }
    useAppStore.setState({
      repos: [repo, { ...repo, executionHostId: 'runtime:peer' }, otherRepo],
      projects: [project],
      worktreesByRepo: {
        [repo.id]: [worktree, { ...worktree, hostId: 'runtime:peer' }],
        [otherRepo.id]: [other]
      },
      activeRepoId: otherRepo.id,
      activeWorktreeId: other.id,
      activeWorkspaceExecutionHostId: 'local',
      detectedAgentIds: ['claude'],
      localDetectedAgentIdsByContext: warm ? { host: ['codex'] } : {}
    })
    mount()
    await act(async () => requestQuickChatFromShortcut())
    await waitFor(() => expect(mocks.launch).toHaveBeenCalledOnce())
    expect(mocks.launch.mock.calls[0][0]).toMatchObject({
      worktreeId: worktree.id,
      selectedExecutionHostId: 'local',
      requestedSurface: 'chat',
      agent: 'codex'
    })
    expect(mocks.detect.mock.calls.every(([context]) => !context?.wslDistro)).toBe(true)
  }
)
