import { getDefaultSettings } from '../../../shared/constants'
import { buildQuickComposerStartup } from '@/hooks/composer-state/quick-startup-plan'
// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import type { WorktreeCreationRequest } from './pending-worktree-creation'
import { buildWorktreeCreationStartupOpt } from './worktree-creation-flow-startup'
import { ensureWebRuntimeWorktreeTerminalAfterWake } from './web-runtime-worktree-terminal-after-wake'
import { openBackgroundDeclinedTerminal } from './worktree-creation-background-mount'
import { seedAgentTabStateAfterWorktreeCreate } from './worktree-creation-agent-seeds'
import { resetWebRuntimeWakeTerminalRespawnForTests } from '@/runtime/web-runtime-wake-terminal-respawn'

const mocks = vi.hoisted(
  (): {
    launch: ReturnType<typeof vi.fn>
    seedOptions: ReturnType<typeof vi.fn>
    seedDraft: ReturnType<typeof vi.fn>
    agent: 'claude' | 'codex'
  } => ({
    launch: vi.fn(),
    seedOptions: vi.fn(),
    seedDraft: vi.fn(),
    agent: 'claude'
  })
)
vi.mock('@/lib/launch-agent-web-host-tab', () => ({ launchAgentInWebHostTab: mocks.launch }))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  runtimeEnvironmentIdOrLocalUnlessTwin: () => 'host'
}))
vi.mock('@/runtime/web-runtime-session-environment', () => ({
  isWebRuntimeSessionActive: () => true
}))
vi.mock('../../../shared/native-chat/input/native-chat-session-option-cache', () => ({
  seedNativeChatAppliedSessionOptions: mocks.seedOptions
}))
vi.mock('@/lib/agent-launch-prompt-delivery', () => ({
  seedNativeChatLaunchDraftForAgentTab: mocks.seedDraft
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      getKnownWorktreeById: () => ({ id: 'wt' }),
      tabsByWorktree: { wt: [{ id: 'agent-tab', launchAgent: mocks.agent }] },
      ptyIdsByTabId: {}
    })
  }
}))

const request: WorktreeCreationRequest = {
  repoId: 'repo',
  name: 'created',
  agent: 'claude',
  setupDecision: 'skip',
  pendingFirstAgentMessageRename: false,
  note: '',
  startupPlan: null,
  quickPrompt: '',
  quickTelemetry: null,
  launchDraftPrompt: 'ship it',
  launchInputs: { agentArgs: '', sessionOptions: { model: 'opus', effort: 'high' } },
  creationStartup: {
    legacy: () => {
      throw new Error('desktop parser reached')
    },
    sessionOptions: { model: 'opus', effort: 'high' }
  }
}
afterEach(() => {
  vi.clearAllMocks()
  resetWebRuntimeWakeTerminalRespawnForTests()
})

it('retains a null-plan recovery payload and serializes concurrent after-wake attempts', async () => {
  const pending = Promise.withResolvers<{ outcome: { status: 'created' } }>()
  mocks.launch.mockReturnValue(pending.promise)
  const startup = buildWorktreeCreationStartupOpt(request, false)
  expect(startup).toMatchObject({
    launchAgent: 'claude',
    launchToken: expect.any(String),
    freshAgentLaunch: {
      agentArgs: '',
      sessionOptions: { model: 'opus', effort: 'high' },
      prompt: 'ship it',
      promptDelivery: 'draft'
    }
  })
  ensureWebRuntimeWorktreeTerminalAfterWake('wt', { startup, agent: 'claude', activate: false })
  ensureWebRuntimeWorktreeTerminalAfterWake('wt', { startup, agent: 'claude', activate: false })
  expect(mocks.launch).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      agentArgs: '',
      sessionOptions: { model: 'opus', effort: 'high' },
      prompt: 'ship it',
      promptDelivery: 'draft',
      activate: false,
      selectWorktree: false
    })
  )
  pending.resolve({ outcome: { status: 'created' } })
  await pending.promise
})

it('seeds the tab options and draft from creation intent without building a desktop plan', () => {
  seedAgentTabStateAfterWorktreeCreate({
    request,
    worktreeId: 'wt',
    primaryTabId: 'agent-tab',
    startupTerminalTabId: undefined,
    backendSpawned: false
  })
  expect(mocks.seedOptions).toHaveBeenCalledWith('agent-tab', 'claude', {
    model: 'opus',
    effort: 'high'
  })
  expect(mocks.seedDraft).toHaveBeenCalledWith({
    tabId: 'agent-tab',
    agent: 'claude',
    text: 'ship it'
  })
})

it('gives a background decline one delivery owner with original picks and cancellation', async () => {
  mocks.launch.mockResolvedValue({
    outcome: { status: 'created' },
    delivered: true,
    failureNotified: false
  })
  const cancellation = new AbortController()
  const terminal = openBackgroundDeclinedTerminal(
    { request, worktreeId: 'wt' },
    { kind: 'environment', environmentId: 'host' },
    'held message',
    cancellation.signal
  )
  expect(mocks.launch).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      agentArgs: '',
      sessionOptions: { model: 'opus', effort: 'high' },
      prompt: 'held message',
      promptDelivery: 'draft',
      activate: false,
      selectWorktree: false
    })
  )
  cancellation.abort()
  expect(mocks.launch.mock.calls[0]?.[0].isCancelled()).toBe(true)
  await expect(terminal.promptDeliveryResult).resolves.toEqual({
    delivered: true,
    failureNotified: false
  })
})

it('does not seed the requested agent picks onto a substituted agent tab', () => {
  mocks.agent = 'codex'
  seedAgentTabStateAfterWorktreeCreate({
    request,
    startupAgent: 'codex',
    worktreeId: 'wt',
    primaryTabId: 'agent-tab',
    startupTerminalTabId: 'agent-tab',
    backendSpawned: true
  })
  expect(mocks.seedOptions).toHaveBeenCalledWith('web-terminal-agent-tab', 'codex', undefined)
  expect(mocks.seedDraft).toHaveBeenCalledWith({
    tabId: 'web-terminal-agent-tab',
    agent: 'codex',
    text: 'ship it'
  })
  mocks.agent = 'claude'
})

it('prepares the held background message with the real compatibility builder and original picks', () => {
  const legacyRequest: WorktreeCreationRequest = {
    ...request,
    quickPrompt: 'original prompt',
    launchDraftPrompt: undefined,
    creationStartup: {
      legacy: (prompt, delivery) =>
        buildQuickComposerStartup({
          agent: 'claude',
          prompt: prompt ?? 'original prompt',
          draftPrompt: delivery === 'draft' ? prompt : null,
          settings: {
            ...getDefaultSettings('/tmp'),
            agentCmdOverrides: { claude: '/desktop/claude' }
          },
          launchHost: { kind: 'known', hostKind: 'runtime', platform: 'linux' },
          shell: 'posix',
          isRemote: true,
          telemetrySource: undefined,
          launchInputs: { agentArgs: '--add-dir /host/shared', sessionOptions: { model: 'opus' } }
        })
    }
  }
  mocks.launch.mockResolvedValue({ outcome: { status: 'created' } })
  openBackgroundDeclinedTerminal(
    { request: legacyRequest, worktreeId: 'wt' },
    { kind: 'environment', environmentId: 'host' },
    'held message'
  )
  const prepared = mocks.launch.mock.calls[0]?.[0].buildStartup()
  expect(prepared.startupPlan.launchCommand).toContain("'held message'")
  expect(prepared.startupPlan.launchCommand).toContain("'/host/shared'")
  expect(prepared.startupPlan.launchCommand).toContain("'opus'")
  expect(prepared.startupPlan.launchCommand).not.toContain('original prompt')
  expect(prepared.pasteDraftAfterLaunch).toBeNull()
  expect(prepared.submitPastedPrompt).toBe(false)
})
