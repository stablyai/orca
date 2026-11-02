// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { getDefaultSettings } from '../../../shared/constants'
import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { localWorktreeFetch } from '@/store/slices/local-worktree-fetch.test-fixture'
import { noteUserWorkspaceSwitch } from './workspace-switch-user-act'
import { QuickChatConfirmation, quickChatConfirmation } from './quick-chat-confirmation'
import { QuickChatButton } from '@/components/QuickChatButton'
import type * as Launcher from './launch-agent-in-new-tab'

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  actualLaunch: null as null | typeof Launcher.launchAgentInNewTab,
  provisional: vi.fn(),
  activate: vi.fn(),
  ensure: vi.fn(),
  write: vi.fn(),
  error: vi.fn()
}))
vi.mock('./launch-agent-in-new-tab', async (original) => {
  const actual = await original<typeof Launcher>()
  mocks.actualLaunch = actual.launchAgentInNewTab
  return { ...actual, launchAgentInNewTab: mocks.launch }
})
vi.mock('@/lib/agent-session/structured-agent-session-provisional-tab', () => ({
  beginStructuredAgentSessionProvisionalLaunch: mocks.provisional
}))
vi.mock('./worktree-activation', () => ({ activateAndRevealWorktree: mocks.activate }))
vi.mock('./onboarding-project-checklist', () => ({ markOnboardingProjectAdded: async () => {} }))
vi.mock('./focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))
vi.mock('@/components/native-chat/use-native-chat-composer-reveal-focus', () => ({
  captureNativeChatComposerFocusIntent: () => ({ request: vi.fn(), cancel: vi.fn() }),
  requestNativeChatComposerFocus: vi.fn()
}))
vi.mock('@/i18n/use-ui-language-revision', () => ({ useUiLanguageRevision: () => {} }))
vi.mock('sonner', () => ({
  toast: { error: mocks.error, success: vi.fn(), info: vi.fn(), message: vi.fn() }
}))

const initial = useAppStore.getInitialState()
const repo = { ...TEST_REPO, id: 'chats', path: '/data/chats', kind: 'folder' as const }
const worktree = makeWorktree({
  id: 'chats::/data/chats',
  repoId: repo.id,
  hostId: 'local',
  path: repo.path
})
const shipped = getDefaultSettings('/home/me')

function setup(settings: GlobalSettings = shipped) {
  useAppStore.setState({
    settings,
    repos: [],
    worktreesByRepo: {},
    activeView: 'terminal',
    addRepoPath: async () => {
      useAppStore.setState({ repos: [repo], worktreesByRepo: { [repo.id]: [worktree] } })
      return repo
    },
    fetchWorktrees: localWorktreeFetch(Promise.resolve(true)),
    refreshDetectedAgents: async () => ['codex'],
    updateSettingsOrThrow: async (updates) => {
      mocks.write(updates)
      useAppStore.setState((state) => ({
        settings: state.settings && { ...state.settings, ...updates }
      }))
    }
  })
}

beforeEach(() => {
  useAppStore.setState(initial, true)
  vi.clearAllMocks()
  mocks.ensure.mockResolvedValue({ path: repo.path, canonicalPath: repo.path })
  mocks.launch.mockReturnValue({ surface: { kind: 'host-published' } })
  mocks.activate.mockImplementation((id: string) => {
    useAppStore.setState({ activeWorktreeId: id, activeWorkspaceExecutionHostId: 'local' })
    return { primaryTabId: null }
  })
  Object.assign(window, { api: { repos: { ensureQuickChatFolder: mocks.ensure } } })
  setup()
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
})

it.each(['terminal', 'chat'] as const)(
  'Start chatting saves the confirmed %s answer at shipped defaults and opens that agent in Chats',
  async (surface) => {
    render(<QuickChatButton />)
    if (surface === 'chat') {
      await act(() => quickChatConfirmation.open())
      quickChatConfirmation.setDraft({ surface })
    }
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start chatting' })))
    await waitFor(() => expect(mocks.launch).toHaveBeenCalledOnce())
    expect(mocks.write.mock.calls).toEqual([
      [{ agentDefaultSurface: surface, defaultTuiAgent: 'codex', newWorkspaceSetupOnly: false }]
    ])
    expect(mocks.activate).toHaveBeenCalledWith(worktree.id, {
      executionHostId: 'local',
      providesInitialSurface: true
    })
    expect(mocks.launch.mock.calls[0][0]).toMatchObject({
      agent: 'codex',
      requestedSurface: surface,
      selectedExecutionHostId: 'local',
      worktreeId: worktree.id
    })
    expect(quickChatConfirmation.read()).toMatchObject({ open: false, phase: 'done' })
  }
)

it("clears only the chosen agent's own Chat/CLI choice so it follows the new default", async () => {
  setup({
    ...shipped,
    defaultTuiAgent: 'codex',
    nativeChatProviders: { codex: false, claude: true }
  })
  const owner = new QuickChatConfirmation()
  await owner.open()
  owner.setDraft({ surface: 'chat' })
  await owner.confirm()
  expect(mocks.write).toHaveBeenCalledExactlyOnceWith({
    agentDefaultSurface: 'chat',
    defaultTuiAgent: 'codex',
    newWorkspaceSetupOnly: false,
    nativeChatProviders: { claude: true }
  })
  expect(mocks.launch.mock.calls[0][0]).toMatchObject({ agent: 'codex', requestedSurface: 'chat' })
})

it('saves and creates nothing when the answers are dismissed without Confirm', async () => {
  const owner = new QuickChatConfirmation()
  await owner.open()
  owner.setDraft({ agent: 'claude', surface: 'chat' })
  expect(owner.dismiss()).toBe(true)
  await owner.confirm()
  expect(mocks.write).not.toHaveBeenCalled()
  expect(mocks.ensure).not.toHaveBeenCalled()
  expect(mocks.launch).not.toHaveBeenCalled()
  expect(useAppStore.getState().repos).toEqual([])
})

it('shares one attempt across a double Confirm and a repeated Start chatting', async () => {
  let release = () => {}
  mocks.ensure.mockReturnValueOnce(
    new Promise((resolve) => {
      release = () => resolve({ path: repo.path, canonicalPath: repo.path })
    })
  )
  const owner = new QuickChatConfirmation()
  await owner.open()
  const first = owner.confirm()
  expect(owner.confirm()).toBe(first)
  await owner.open()
  expect(owner.confirm()).toBe(first)
  expect(owner.dismiss()).toBe(false)
  await act(async () => release())
  await first
  expect(mocks.write).toHaveBeenCalledOnce()
  expect(mocks.ensure).toHaveBeenCalledOnce()
  expect(mocks.launch).toHaveBeenCalledOnce()
})

it('stops before creating Chats when the settings write is rejected, and a retry succeeds', async () => {
  const write = useAppStore.getState().updateSettingsOrThrow
  useAppStore.setState({
    updateSettingsOrThrow: vi
      .fn<typeof write>()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockImplementation(write)
  })
  const owner = new QuickChatConfirmation()
  await owner.open()
  owner.setDraft({ surface: 'chat' })
  await owner.confirm()
  expect(mocks.error).toHaveBeenCalledOnce()
  expect(mocks.ensure).not.toHaveBeenCalled()
  expect(owner.read()).toMatchObject({
    open: true,
    phase: 'failed',
    draft: { agent: 'codex', surface: 'chat' }
  })
  await owner.confirm()
  expect(mocks.launch).toHaveBeenCalledOnce()
  expect(mocks.launch.mock.calls[0][0]).toMatchObject({ requestedSurface: 'chat' })
  expect(mocks.error).toHaveBeenCalledOnce()
})

it.each(['leave and return', 'reselect a workspace'])(
  'cancels activation and launch when the user navigates (%s) during the commit',
  async (navigation) => {
    let release = () => {}
    mocks.ensure.mockReturnValueOnce(
      new Promise((resolve) => {
        release = () => resolve({ path: repo.path, canonicalPath: repo.path })
      })
    )
    const owner = new QuickChatConfirmation()
    await owner.open()
    const attempt = owner.confirm()
    await act(async () => {
      if (navigation === 'leave and return') {
        useAppStore.setState({ activeView: 'settings' })
        useAppStore.setState({ activeView: 'terminal' })
      } else {
        noteUserWorkspaceSwitch(worktree.id)
      }
      release()
    })
    await attempt
    expect(mocks.activate).not.toHaveBeenCalled()
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(owner.read()).toMatchObject({ open: false, phase: 'idle' })
  }
)

it('hands an explicit Chat for an agent that cannot chat to chat admission, never to a terminal', async () => {
  mocks.launch.mockImplementation((args) => mocks.actualLaunch!(args))
  mocks.provisional.mockReturnValue(null)
  const owner = new QuickChatConfirmation()
  await owner.open()
  owner.setDraft({ agent: 'aider', surface: 'chat' })
  await owner.confirm()
  expect(mocks.provisional).toHaveBeenCalledOnce()
  expect(mocks.provisional.mock.calls[0][0].plan).toMatchObject({
    route: 'structured-native-chat',
    requestedSurface: 'chat',
    agent: 'aider'
  })
  expect(Object.values(useAppStore.getState().tabsByWorktree).flat()).toEqual([])
})
