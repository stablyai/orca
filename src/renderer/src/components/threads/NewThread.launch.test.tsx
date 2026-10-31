// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useRef } from 'react'
import {
  NativeChatComposer,
  type NativeChatComposerHandle
} from '../native-chat/NativeChatComposer'
import { useNativeChatComposerRevealFocus } from '../native-chat/use-native-chat-composer-reveal-focus'
import { makeUnifiedTab, makeTabGroup } from '@/store/slices/store-test-helpers'
import { launchStructuredAgentFromNewTab } from '@/lib/launch-agent-in-new-tab-structured-route'
import { adoptAgentSessionLaunchVerdict } from '@/lib/agent-session-launch-plan'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { selectThread, sendNewThread } from './thread-actions'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { promptEditor } from '../native-chat/native-chat-prompt-editor.test-support'
import { TooltipProvider } from '../ui/tooltip'
import { NewThread } from './NewThread'
import { ThreadsSection } from './ThreadsSection'
import { useGlobalKeybindings } from '@/app-shell/use-global-keybindings'
import { useAppChromeLayout } from '@/app-shell/use-app-chrome-layout'
import { useFloatingWorkspacePanel } from '@/app-shell/use-floating-workspace-panel'
import { buildAgentLaunchRouteInput } from '@/lib/agent-launch-route-input'
import { useThreadNavigation } from './thread-navigation'
import {
  readNativeChatComposerDraft,
  clearNativeChatComposerDraftsForTests,
  structuredAgentSessionDraftScopeKey
} from '../native-chat/native-chat-composer-draft-store'
import { resetStructuredAgentLaunchRegistryForTests } from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs-drawn-from-main.test-fixture'
import { StructuredAgentSessionCreateRefusalError } from '@/lib/structured-agent-session-launch-errors'
import type * as LaunchModule from '@/lib/structured-agent-session-launch-create-call'
import type { AgentPickerEntry } from '../../../../shared/agent-launch-picker'

const mocks = vi.hoisted(() => ({
  support: vi.fn(),
  launch: vi.fn(),
  menu: vi.fn(),
  inventory: vi.fn(),
  loading: false,
  model: null
}))
vi.mock('@/app-shell/app-window-chrome', async (original) => ({
  ...(await original<object>()),
  shortcutPlatform: 'darwin'
}))
vi.mock('@/runtime/runtime-rpc-client', async (original) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await original())
)
vi.mock('@/runtime/runtime-layout-client', async (original) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await original())
)
vi.mock('@/lib/structured-agent-session-launch-create-call', async (original) => ({
  ...(await original<typeof LaunchModule>()),
  launchStructuredAgentSession: mocks.launch
}))
vi.mock('@/lib/structured-agent-session-host-admission', async (original) => ({
  ...(await original<object>()),
  admitStructuredLaunchOnHost: mocks.support
}))
vi.mock('../tab-bar/use-new-tab-agent-menu-rows', () => ({
  useNewTabAgentMenuRows: (...args: unknown[]) => {
    mocks.menu(...args)
    return mocks.model
  }
}))
vi.mock('../agent/use-agent-launch-picker-inventory', () => ({
  useAgentLaunchPickerInventory: mocks.inventory
}))
const inventory = [
  {
    agent: 'claude',
    label: 'Claude',
    surfaces: ['chat'],
    defaultSurface: 'chat',
    structured: { model: 'opus[1m]', permissionMode: 'ask' },
    terminal: {},
    rows: [],
    catalog: {
      origin: 'probe',
      fetchedAt: 1,
      models: [{ id: 'opus[1m]', label: 'Opus 1M', isDefault: true, efforts: [] }]
    }
  },
  {
    agent: 'codex',
    label: 'Codex',
    surfaces: ['chat'],
    defaultSurface: 'chat',
    structured: { model: 'gpt-5.5', permissionMode: 'ask' },
    terminal: {},
    rows: [],
    catalog: {
      origin: 'probe',
      fetchedAt: 1,
      models: [{ id: 'opus[1m]', label: 'Opus 1M', isDefault: true, efforts: [] }]
    }
  }
] satisfies AgentPickerEntry[]
vi.mock('../native-chat/use-native-chat-skills', () => ({
  useNativeChatSkills: () => ({ status: 'ready', skills: [], error: null, retry: () => {} })
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }))
const projects = ['A', 'B'].map((id) => ({
  key: `local|${id}`,
  hostId: 'local' as const,
  repo: { id, path: `/${id}`, displayName: id, badgeColor: '', addedAt: 1 },
  worktree: makeWorktree({
    id: `${id}::/${id}`,
    repoId: id,
    path: `/${id}`,
    isMainWorktree: true,
    hostId: 'local'
  })
}))
vi.mock('./thread-projects', async (original) => ({
  ...(await original<object>()),
  eligibleThreadProjects: async () => projects
}))
vi.mock('./use-thread-projects', () => ({
  useThreadProjects: () => ({ projects, loading: mocks.loading })
}))
function Draft() {
  const selected = useThreadNavigation((s) => s.selection)
  return (
    <TooltipProvider>
      {selected?.kind === 'new' ? (
        <NewThread key={selected.draftId} {...selected} />
      ) : (
        <div>Opened conversation</div>
      )}
    </TooltipProvider>
  )
}
let main: TabsDrawnFromMain
beforeEach(async () => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      runtime: {
        call: vi.fn(async () => ({
          id: 'test',
          ok: true,
          result: null,
          _meta: { runtimeId: 'local' }
        }))
      }
    }
  })
  clearNativeChatComposerDraftsForTests()
  resetStructuredAgentLaunchRegistryForTests()
  vi.clearAllMocks()
  mocks.loading = false
  mocks.inventory.mockReturnValue(inventory)
  mocks.support.mockResolvedValue({ kind: 'admitted' })
  useThreadNavigation.setState({
    selection: { kind: 'new', projectKey: projects[0].key, draftId: 'one' }
  })
  useAppStore.setState({
    settings: {
      ...useAppStore.getState().settings!,
      experimentalThreads: true,
      defaultTuiAgent: 'claude'
    },
    activeView: 'terminal',
    activeRepoId: 'A',
    activeWorktreeId: projects[0].worktree.id,
    activeWorkspaceExecutionHostId: 'local',
    repos: projects.map((p) => p.repo),
    worktreesByRepo: Object.fromEntries(projects.map((p) => [p.repo.id, [p.worktree]])),
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    reconcileWorktreeTabModel: vi.fn(() => ({ renderableTabCount: 1 })),
    refreshGitHubForWorktreeIfStale: vi.fn(),
    revealWorktreeInSidebar: vi.fn(),
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    tabsByWorktree: {},
    tabBarOrderByWorktree: {},
    activeModal: 'none'
  })
  main = await drawTabsFromMain(useAppStore)
})
afterEach(() => {
  cleanup()
  main.close()
})
async function submit() {
  const composer = screen.getByRole('textbox', {
    name: 'Ask for changes, or ask anything about this project'
  })
  act(() => promptEditor(composer).commands.insertContent('Preserve prompt'))
  fireEvent.keyDown(composer, { key: 'Enter' })
  await waitFor(() => expect(mocks.support).toHaveBeenCalled())
  return composer
}
it('renders real first-send agent/model and permission controls and captures explicit aliases without catalog confirmation', async () => {
  const admission = Promise.withResolvers<{ kind: 'admitted' }>()
  const creation =
    Promise.withResolvers<Awaited<ReturnType<typeof LaunchModule.launchStructuredAgentSession>>>()
  mocks.launch.mockReturnValue(creation.promise)
  mocks.support.mockReturnValue(admission.promise)
  const view = render(<Draft />)
  expect(screen.getByRole('button', { name: /Agent Opus/ })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /Agent Opus/ }))
  expect(screen.getByRole('option', { name: /Codex/ }).textContent).toContain('gpt-5.5')
  fireEvent.click(screen.getByRole('option', { name: /Claude/ }))
  // A real explicit model selection uses the shared draft editor; missing model lists do not gate Send.
  fireEvent.click(screen.getByRole('button', { name: /Agent Opus/ }))
  const model = screen.getAllByRole('option').find((node) => node.textContent === 'Opus 1M')
  if (!model) {
    throw new Error('curated Opus model missing')
  }
  fireEvent.click(model)
  const permission = screen.getByRole('button', { name: /Ask/ })
  fireEvent.pointerDown(permission, { button: 0, ctrlKey: false })
  const approve = screen.getByRole('menuitemradio', { name: /Approve for me/ })
  fireEvent.click(approve)
  mocks.inventory.mockReturnValue([])
  view.rerender(<Draft />)
  const menuTarget = mocks.menu.mock.calls.at(-1)?.[0]
  expect(
    buildAgentLaunchRouteInput(useAppStore.getState(), {
      agent: 'claude',
      workspace: menuTarget.workspace
    }).executionHostId
  ).toBe('local')
  const composer = await submit()
  expect(composer.textContent).toBe('')
  fireEvent.click(screen.getByRole('button', { name: 'Choose project' }))
  fireEvent.click(screen.getByRole('option', { name: 'B' }))
  await act(async () => {
    admission.resolve({ kind: 'admitted' })
    await main.settle()
  })
  await waitFor(() => expect(mocks.launch).toHaveBeenCalledOnce())
  expect(mocks.launch.mock.calls[0][0]).toMatchObject({
    agent: 'claude',
    params: { surface: 'thread' },
    explicitLaunchOptions: { model: 'opus[1m]', permissionMode: 'auto' }
  })
  await act(async () =>
    creation.reject(
      new StructuredAgentSessionCreateRefusalError('structured_agent_session_unsupported')
    )
  )
  await waitFor(() => expect(composer.getAttribute('contenteditable')).toBe('true'))
  expect(composer.textContent).toBe('')
})
it.each(['before', 'after'] as const)(
  'production %s-admission failure keeps exactly one recoverable prompt and preserves project navigation',
  async (phase) => {
    const admission = Promise.withResolvers<{ kind: 'admitted' | 'declined' }>()
    const creation =
      Promise.withResolvers<Awaited<ReturnType<typeof LaunchModule.launchStructuredAgentSession>>>()
    mocks.support.mockReturnValue(admission.promise)
    mocks.launch.mockReturnValue(creation.promise)
    render(<Draft />)
    const composer = await submit()
    fireEvent.click(screen.getByRole('button', { name: 'Choose project' }))
    fireEvent.click(screen.getByRole('option', { name: 'B' }))
    await act(async () => {
      admission.resolve({ kind: phase === 'before' ? 'declined' : 'admitted' })
      await main.settle()
    })
    if (phase === 'after') {
      await waitFor(() => expect(mocks.launch).toHaveBeenCalledOnce())
      await act(async () =>
        creation.reject(
          new StructuredAgentSessionCreateRefusalError('structured_agent_session_unsupported')
        )
      )
    }
    await waitFor(() => expect(composer.getAttribute('contenteditable')).toBe('true'))
    expect(screen.getByRole('button', { name: 'Choose project' }).textContent).toBe('B')
    const tabs = Object.values(useAppStore.getState().unifiedTabsByWorktree)
      .flat()
      .filter((tab) => tab.contentType === 'agent-session')
    expect(tabs).toHaveLength(phase === 'after' ? 1 : 0)
    expect(composer.textContent).toBe(phase === 'before' ? 'Preserve prompt' : '')
    if (phase === 'after') {
      expect(
        readNativeChatComposerDraft(structuredAgentSessionDraftScopeKey(tabs[0].entityId)).text
      ).toBe('Preserve prompt')
    }
    expect(readNativeChatComposerDraft('thread-draft:one').text).toBe(
      phase === 'before' ? 'Preserve prompt' : ''
    )
  }
)

it('promotes a same-project draft after an equivalent selection object was replaced, through production onOpened', async () => {
  const admission = Promise.withResolvers<{ kind: 'admitted' }>()
  const creation =
    Promise.withResolvers<Awaited<ReturnType<typeof LaunchModule.launchStructuredAgentSession>>>()
  mocks.support.mockReturnValue(admission.promise)
  mocks.launch.mockReturnValue(creation.promise)
  render(<Draft />)
  await submit()
  act(() =>
    useThreadNavigation.setState({
      selection: { kind: 'new', projectKey: projects[0].key, draftId: 'one' }
    })
  )
  await act(async () => {
    admission.resolve({ kind: 'admitted' })
    await main.settle()
  })
  await waitFor(() => expect(screen.getByText('Opened conversation')).toBeTruthy())
  expect(useThreadNavigation.getState().selection).toBeNull()
  const tab = Object.values(useAppStore.getState().unifiedTabsByWorktree).flat()[0]
  expect(
    useAppStore.getState().groupsByWorktree[tab.worktreeId].find((g) => g.id === tab.groupId)
      ?.activeTabId
  ).toBe(tab.id)
  await act(async () =>
    creation.reject(
      new StructuredAgentSessionCreateRefusalError('structured_agent_session_unsupported')
    )
  )
})
function Entry() {
  useGlobalKeybindings({
    layout: useAppChromeLayout(),
    floatingWorkspace: useFloatingWorkspacePanel()
  })
  return (
    <>
      <TooltipProvider>
        <ThreadsSection />
      </TooltipProvider>
      <Draft />
    </>
  )
}
it.each(['plus', 'shortcut'] as const)(
  'focuses the actual composer from %s after delayed capabilities',
  async (entry) => {
    mocks.loading = true
    useThreadNavigation.setState({ selection: null })
    const view = render(<Entry />)
    if (entry === 'plus') {
      fireEvent.click(screen.getByRole('button', { name: 'New thread' }))
    } else {
      fireEvent.keyDown(window, { key: 'n', code: 'KeyN', metaKey: true, altKey: true })
    }
    const composer = await screen.findByRole('textbox', {
      name: 'Ask for changes, or ask anything about this project'
    })
    expect(document.activeElement).not.toBe(composer)
    mocks.loading = false
    view.rerender(<Entry />)
    await waitFor(() => expect(document.activeElement).toBe(composer))
    expect(mocks.support).not.toHaveBeenCalled()
    expect(mocks.launch).not.toHaveBeenCalled()
  }
)

it('an existing chat activation focuses the actual composer through the normal activation owner', async () => {
  const tab = makeUnifiedTab({
    id: 'selected-chat',
    entityId: 'selected-session',
    worktreeId: projects[0].worktree.id,
    groupId: 'selected-group',
    contentType: 'agent-session',
    agentSessionAgent: 'claude',
    executionHostId: 'local'
  })
  useAppStore.setState({
    unifiedTabsByWorktree: { [tab.worktreeId]: [tab] },
    groupsByWorktree: {
      [tab.worktreeId]: [
        makeTabGroup({
          id: tab.groupId,
          worktreeId: tab.worktreeId,
          activeTabId: tab.id,
          tabOrder: [tab.id]
        })
      ]
    },
    activeGroupIdByWorktree: { [tab.worktreeId]: tab.groupId }
  })
  function Chat() {
    const root = useRef<HTMLDivElement>(null)
    const composer = useRef<NativeChatComposerHandle>(null)
    useNativeChatComposerRevealFocus({
      tabId: tab.id,
      rootRef: root,
      composerRef: composer,
      isVisible: true,
      isFocusedGroup: true,
      composerReady: true
    })
    return (
      <div ref={root}>
        <TooltipProvider>
          <NativeChatComposer
            ref={composer}
            terminalTabId={tab.id}
            paneKey={`${tab.id}:root`}
            targetPtyId={null}
            agent="claude"
            canSend
            structuredTransport={{
              capturePresentation: () => () => true,
              dispatchCommand: async () => ({ handled: false, accepted: false, error: null }),
              send: () => true,
              optionsSurface: {
                getSnapshot: () => [],
                setOption: async () => ({ snapshot: [] }),
                invokeAction: async () => ({ snapshot: [] }),
                subscribe: () => () => {}
              },
              optionSnapshot: [],
              acceptsImages: false,
              onError: () => {},
              runtime: 'local',
              runtimeEnvironmentId: null,
              sessionId: tab.entityId
            }}
          />
        </TooltipProvider>
        <button>Other control</button>
      </div>
    )
  }
  render(<Chat />)
  const composer = screen.getByRole('textbox')
  await waitFor(() => expect(document.activeElement).toBe(composer))
  screen.getByRole('button', { name: 'Other control' }).focus()
  act(() => selectThread(tab))
  await waitFor(() => expect(document.activeElement).toBe(composer))
  expect(useThreadNavigation.getState().selection).toBeNull()
})

it.each(['declined', 'admitted'] as const)(
  'preserves existing explicit-chat admission inputs and refusal policy on the thread path: %s',
  async (answer) => {
    mocks.support.mockResolvedValue({ kind: answer })
    mocks.launch.mockRejectedValue(
      new StructuredAgentSessionCreateRefusalError('structured_agent_session_unsupported')
    )
    const openTerminal = vi.fn(() => null)
    const launchOptions = { model: 'opus[1m]', permissionMode: 'ask' }
    const ordinary = launchStructuredAgentFromNewTab({
      plan: adoptAgentSessionLaunchVerdict({
        route: 'structured-native-chat',
        requestedSurface: 'chat',
        requestId: newAgentLaunchRequestId(),
        worktreeId: projects[0].worktree.id,
        executionHostId: 'local',
        agent: 'claude',
        prompt: 'Preserve prompt',
        promptDelivery: 'auto-submit',
        launchOptions
      }),
      worktreeId: projects[0].worktree.id,
      openTerminal
    })
    if (!ordinary) {
      throw new Error('ordinary explicit chat was not launched')
    }
    expect((await ordinary.structuredSettlement).kind).toBe('failed')
    const admission = mocks.support.mock.calls[0]
    const ordinaryInput = mocks.launch.mock.calls[0]?.[0]
    mocks.support.mockClear()
    mocks.launch.mockClear()
    const thread = sendNewThread(projects[0], 'Preserve prompt', { agent: 'claude', launchOptions })
    if (!thread) {
      throw new Error('thread was not launched')
    }
    expect((await thread.settlement).kind).toBe('failed')
    await main.settle()
    expect(mocks.support.mock.calls[0]).toEqual(admission)
    expect(openTerminal).not.toHaveBeenCalled()
    if (answer === 'declined') {
      expect(mocks.launch).not.toHaveBeenCalled()
      expect(Object.values(useAppStore.getState().unifiedTabsByWorktree).flat()).toEqual([])
    } else {
      const input = mocks.launch.mock.calls[0][0]
      expect(input).toMatchObject({
        agent: ordinaryInput.agent,
        worktreeId: ordinaryInput.worktreeId,
        target: ordinaryInput.target,
        explicitLaunchOptions: ordinaryInput.explicitLaunchOptions,
        params: { surface: 'thread' }
      })
      expect(ordinaryInput.params.surface).toBeUndefined()
    }
  }
)
