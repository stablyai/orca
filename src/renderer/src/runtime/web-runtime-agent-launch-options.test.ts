import { afterEach, expect, it, vi } from 'vitest'
import { resetWebSessionCloseIntentForTests } from './web-session-close-intent'
import {
  WORKTREE_ID,
  FOCUS_LEAF_ID,
  ENVIRONMENT_ID,
  resetTerminalCreateEnvironment,
  stubTerminalCreateEnvironment
} from './web-runtime-session-test-harness'
import { stubRuntimeEnvironmentBridge } from './runtime-environment-bridge-fixture'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  setState: vi.fn(),
  subscribe: vi.fn(),
  setActiveWorktree: vi.fn(),
  createBrowserTab: vi.fn(),
  closeEmptyGroup: vi.fn(),
  moveUnifiedTabToGroup: vi.fn(),
  setRemoteBrowserPageHandle: vi.fn(),
  focusBrowserTabInWorktree: vi.fn(),
  applyWebSessionTabsSnapshot: vi.fn(),
  decideWebSessionTabsSnapshot: vi.fn(() => ({ apply: true, settlesHostMirror: true })),
  getWebSessionTabsTrackingGeneration: vi.fn(() => 0),
  acceptReplayedWebSessionTabsSnapshot: vi.fn(),
  resolveHostSessionTabIdForWebSessionTab: vi.fn(),
  trackTerminalPaneSplit: vi.fn(),
  deliverLaunchPromptToAgentTab: vi.fn(),
  seedNativeChatLaunchDraftForAgentTab: vi.fn(),
  hasMaterializedWebRuntimeBrowserPage: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('../store', () => ({
  useAppStore: {
    getState: mocks.getState,
    setState: mocks.setState,
    subscribe: mocks.subscribe
  }
}))

vi.mock('./web-session-tabs-sync/tracking-lifecycle', () => ({
  acceptReplayedWebSessionTabsSnapshot: mocks.acceptReplayedWebSessionTabsSnapshot,
  getWebSessionTabsTrackingGeneration: mocks.getWebSessionTabsTrackingGeneration
}))
vi.mock('./web-session-tabs-sync/snapshot-api', () => ({
  applyWebSessionTabsSnapshot: mocks.applyWebSessionTabsSnapshot
}))
vi.mock('./web-session-tabs-sync/tracking-decisions', () => ({
  decideWebSessionTabsSnapshot: mocks.decideWebSessionTabsSnapshot
}))
vi.mock('./web-session-tabs-sync/store-patch', () => ({
  applyWebSessionTabsStorePatch: (buildPatch: (state: unknown) => unknown) => {
    mocks.setState(buildPatch)
    return () => {}
  }
}))
vi.mock('./web-session-tabs-sync/tracking-mappings', () => ({
  resolveHostSessionTabIdForWebSessionTab: mocks.resolveHostSessionTabIdForWebSessionTab
}))

vi.mock('@/lib/feature-education-telemetry', () => ({
  trackTerminalPaneSplit: mocks.trackTerminalPaneSplit
}))

vi.mock('@/lib/agent-launch-prompt-delivery', () => ({
  deliverLaunchPromptToAgentTab: mocks.deliverLaunchPromptToAgentTab,
  seedNativeChatLaunchDraftForAgentTab: mocks.seedNativeChatLaunchDraftForAgentTab
}))

vi.mock('./web-runtime-browser-materialization', () => ({
  hasMaterializedWebRuntimeBrowserPage: mocks.hasMaterializedWebRuntimeBrowserPage
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

afterEach(() => resetWebSessionCloseIntentForTests())

import { beforeEach } from 'vitest'
import { launchAgentInWebHostTab } from '@/lib/launch-agent-web-host-tab'
import { planLaunchAgentStartupPrompt } from '@/lib/launch-agent-startup-prompt-plan'
import { resolveAgentStartupPlanInputs } from '../../../shared/agent-launch/startup/agent-startup-plan-inputs'
import { projectAgentLaunchSettings } from '../../../shared/agent-launch/choices/agent-launch-settings'
import { projectSourceControlActionLaunch } from '../../../shared/source-control/ai/recipes/source-control-action-launch-preferences'
import { createWebRuntimeSessionTerminalResult } from './web-runtime-terminal-create-operation'
import * as preferences from './agent-launch-settings/use-host-agent-launch-preferences'
import * as settingsTransport from './agent-launch-settings/agent-launch-settings-transport'
import { makeSnapshot } from './web-runtime-session-test-harness'

let capabilities: string[]
let refusal: string | undefined
const call = vi.fn(async (request: { method: string; params?: Record<string, unknown> }) => {
  if (request.method === 'status.get') {
    return {
      ok: true,
      result: { runtimeProtocolVersion: 3, minCompatibleRuntimeClientVersion: 2, capabilities }
    }
  }
  if (request.method === 'terminal.createAgentSession' && refusal) {
    return { ok: false, error: { code: refusal, message: 'Use legacy creation' } }
  }
  return {
    ok: true,
    result:
      request.method === 'session.tabs.list'
        ? makeSnapshot()
        : {
            tab: { id: 'host-options', leafId: FOCUS_LEAF_ID },
            terminal: { handle: 'term-options', tabId: 'host-options', leafId: FOCUS_LEAF_ID }
          }
  }
})

beforeEach(() => {
  stubTerminalCreateEnvironment(mocks)
  mocks.getState().runtimeStatusByEnvironmentId = new Map([
    [ENVIRONMENT_ID, { status: { hostPlatform: 'linux' } }]
  ])
  capabilities = ['agent-session.host-authority.v1', 'agent-session.create-options.v1']
  refusal = undefined
  vi.spyOn(preferences, 'ensureAgentLaunchPreferences').mockResolvedValue({
    defaultTuiAgent: undefined,
    disabledTuiAgents: undefined,
    agentLaunchChoices: {}
  })
  vi.spyOn(settingsTransport, 'readHostAgentLaunchSettings').mockResolvedValue(
    projectAgentLaunchSettings(
      {
        agentPermissionDefault: 'full-access',
        agentPermissionOverrides: { claude: 'auto' },
        agentDefaultArgs: { claude: '--add-dir /host-tools' }
      },
      'linux'
    )
  )
  stubRuntimeEnvironmentBridge({ call })
})
afterEach(() => {
  vi.restoreAllMocks()
  resetTerminalCreateEnvironment()
})

function launch(input: Partial<Parameters<typeof launchAgentInWebHostTab>[0]> = {}) {
  const agent = input.agent ?? 'claude'
  const prompt = input.prompt ?? ''
  const promptDelivery = input.promptDelivery ?? 'auto-submit'
  return launchAgentInWebHostTab({
    agent,
    worktreeId: WORKTREE_ID,
    environmentId: ENVIRONMENT_ID,
    activate: false,
    prompt,
    promptDelivery,
    ...input,
    buildStartup:
      input.buildStartup ??
      (() =>
        planLaunchAgentStartupPrompt({
          base: resolveAgentStartupPlanInputs({
            agent,
            settings: {
              agentPermissionDefault: 'own',
              agentDefaultArgs: { claude: '--add-dir /desktop-only' },
              agentCmdOverrides: { claude: 'desktop-claude' }
            },
            agentArgs: input.actionAgentArgs ?? input.agentArgs,
            sessionOptions: input.sessionOptions,
            platform: 'linux',
            isRemote: true,
            shell: 'posix'
          }),
          prompt,
          promptDelivery,
          isFollowupPath: agent === 'goose'
        }))
  })
}
function params(method: string) {
  const request = call.mock.calls.find(([request]) => request.method === method)?.[0]
  expect(request).toBeDefined()
  return request!.params!
}

it('keeps paired + defaults host-owned and sends complete picks and action Arguments separately', async () => {
  const plainOutcome = await launch({
    buildStartup: () => {
      throw new Error('Invalid desktop command')
    }
  })
  expect(plainOutcome.outcome.status).toBe('created')
  const plain = params('terminal.createAgentSession')
  expect(plain).not.toHaveProperty('agentArgs')
  expect(plain).not.toHaveProperty('command')
  expect(plain).not.toHaveProperty('launchConfig')
  call.mockClear()
  const projection = projectSourceControlActionLaunch(
    {
      agentId: 'claude',
      agentArgs: '--verbose',
      launchPreferences: {
        agentId: 'claude',
        model: 'sonnet',
        options: { effort: 'high', fastMode: 'true' }
      }
    },
    'claude',
    { basePrompt: 'Inspect the change', settings: { agentPermissionDefault: 'ask' } }
  )
  await launch({
    sessionOptions: projection.sessionOptions,
    actionAgentArgs: projection.actionAgentArgs,
    prompt: projection.commandInput
  })
  const picked = params('terminal.createAgentSession')
  expect(picked).toMatchObject({
    sessionOptions: { model: 'sonnet', effort: 'high', fastMode: 'true' },
    agentArgs: '--permission-mode auto --verbose',
    prompt: 'Inspect the change'
  })
  expect(picked).not.toHaveProperty('extraAgentArgs')
  expect(
    call.mock.calls.some(([request]) => request.method === 'session.tabs.createTerminal')
  ).toBe(false)
})

it('keeps host authority on older hosts and composes inexpressible picks only from the host snapshot', async () => {
  capabilities = ['agent-session.host-authority.v1']
  await launch({
    sessionOptions: { model: 'sonnet', effort: 'high', permissionMode: 'accept-edits' }
  })
  expect(params('terminal.createAgentSession')).toMatchObject({
    launchPreferences: { model: 'sonnet', effort: 'high', mode: 'accept-edits' }
  })
  expect(params('terminal.createAgentSession')).not.toHaveProperty('agentArgs')
  call.mockClear()
  await launch({ sessionOptions: { effort: 'high' }, actionAgentArgs: '--verbose' })
  const picked = params('terminal.createAgentSession')
  expect(picked.agentArgs).toBe('--effort high --permission-mode auto --verbose')
  expect(picked).not.toHaveProperty('launchPreferences')
  expect(picked).not.toHaveProperty('command')
  expect(picked).not.toHaveProperty('env')
  expect(picked).not.toHaveProperty('sessionOptions')
  call.mockClear()
  vi.mocked(settingsTransport.readHostAgentLaunchSettings).mockResolvedValue(
    projectAgentLaunchSettings(
      {
        agentPermissionDefault: 'full-access',
        agentPermissionOverrides: { claude: 'auto' },
        agentCmdOverrides: { claude: 'claude --model opus' },
        agentLaunchChoices: { claude: { model: 'sonnet' } },
        agentDefaultArgs: { claude: '--add-dir /host-tools' }
      },
      'linux'
    )
  )
  await launch({ actionAgentArgs: '--verbose', sessionOptions: { effort: 'high' } })
  const pinned = params('terminal.createAgentSession')
  expect(pinned.agentArgs).toBe('--effort high --permission-mode auto --verbose')
  expect(pinned).not.toHaveProperty('launchPreferences')
})

it('preserves empty action text and inherits permission from text-only host snapshots', async () => {
  await launch({ actionAgentArgs: '' })
  expect(params('terminal.createAgentSession').agentArgs).toBe('--permission-mode auto')
  call.mockClear()
  vi.mocked(settingsTransport.readHostAgentLaunchSettings).mockResolvedValue({
    defaultTuiAgent: 'claude',
    disabledTuiAgents: [],
    agentCmdOverrides: {},
    agentDefaultArgs: { claude: '--permission-mode auto --add-dir /host-tools' },
    permissionMode: 'mixed',
    environmentNames: {}
  })
  await launch({ actionAgentArgs: '--verbose' })
  expect(params('terminal.createAgentSession').agentArgs).toBe('--permission-mode auto --verbose')
  call.mockClear()
  vi.mocked(settingsTransport.readHostAgentLaunchSettings).mockResolvedValue(null)
  await launch({ actionAgentArgs: '--verbose', prompt: 'Keep this draft', promptDelivery: 'draft' })
  expect(params('session.tabs.createTerminal').command).toContain('--prefill')
  expect(params('session.tabs.createTerminal').command).toContain('--verbose')
  expect(mocks.seedNativeChatLaunchDraftForAgentTab).toHaveBeenCalledWith(
    expect.objectContaining({ text: 'Keep this draft' })
  )
})

it('keeps the prepared launch when an older host snapshot is unavailable', async () => {
  capabilities = ['agent-session.host-authority.v1']
  vi.mocked(settingsTransport.readHostAgentLaunchSettings).mockResolvedValue(null)
  await launch({ sessionOptions: { effort: 'high' } })
  expect(params('session.tabs.createTerminal').command).toContain('desktop-claude')
  expect(params('session.tabs.createTerminal').command).toContain("'high'")
})

it.each(['legacy', 'agent_session_legacy_required', 'method_not_found'])(
  'lets the host plan plain prompted launches through %s fallback',
  async (fallback) => {
    if (fallback === 'legacy') {
      capabilities = []
    } else {
      refusal = fallback
    }
    await launch({ prompt: 'Inspect this change' })
    const legacy = params('session.tabs.createTerminal')
    expect(legacy).toMatchObject({
      agent: 'claude',
      launchAgent: 'claude',
      agentPrompt: 'Inspect this change'
    })
    expect(legacy).not.toHaveProperty('command')
    expect(legacy).not.toHaveProperty('launchConfig')
    call.mockClear()
    await launch({ agent: 'goose', prompt: 'Keep this editable' })
    expect(params('session.tabs.createTerminal')).not.toHaveProperty('agentPrompt')
    expect(mocks.deliverLaunchPromptToAgentTab).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Keep this editable', submit: false })
    )
  }
)

it('retains legacy drafts and submit-after-ready suppression and delivery', async () => {
  capabilities = []
  await launch({ prompt: 'Edit this draft', promptDelivery: 'draft' })
  expect(params('session.tabs.createTerminal').command).toContain('--prefill')
  expect(params('session.tabs.createTerminal')).not.toHaveProperty('agentPrompt')
  expect(mocks.seedNativeChatLaunchDraftForAgentTab).toHaveBeenCalledWith(
    expect.objectContaining({ text: 'Edit this draft' })
  )
  call.mockClear()
  capabilities = ['agent-session.host-authority.v1', 'agent-session.create-options.v1']
  resetTerminalCreateEnvironment()
  stubTerminalCreateEnvironment(mocks)
  stubRuntimeEnvironmentBridge({ call })
  await launch({ prompt: 'Submit this after startup', promptDelivery: 'submit-after-ready' })
  expect(params('terminal.createAgentSession')).toMatchObject({ promptDelivery: 'auto-submit' })
  expect(params('terminal.createAgentSession')).not.toHaveProperty('prompt')
  expect(mocks.deliverLaunchPromptToAgentTab).toHaveBeenCalledWith(
    expect.objectContaining({ content: 'Submit this after startup', submit: true })
  )
})

it('preserves explicit empty overrides and prepared workspace drafts while resume retains its recipe', async () => {
  await launch({ agentArgs: '' })
  expect(params('terminal.createAgentSession')).toHaveProperty('agentArgs', '')
  call.mockClear()
  const recipe = { agentArgs: '--recorded-arguments', agentEnv: {} }
  await createWebRuntimeSessionTerminalResult({
    worktreeId: WORKTREE_ID,
    environmentId: ENVIRONMENT_ID,
    agentSessionKind: 'fresh',
    launchAgent: 'claude',
    preparedAgentCommand: true,
    command: "claude --prefill 'workspace draft'",
    launchConfig: recipe,
    activate: false
  })
  expect(params('session.tabs.createTerminal')).toMatchObject({
    command: "claude --prefill 'workspace draft'",
    launchConfig: recipe
  })
  call.mockClear()
  await createWebRuntimeSessionTerminalResult({
    worktreeId: WORKTREE_ID,
    environmentId: ENVIRONMENT_ID,
    agentSessionKind: 'resume',
    launchAgent: 'claude',
    launchConfig: recipe,
    providerSession: { key: 'session_id', id: 'recorded-session' },
    activate: false
  })
  expect(params('terminal.ensureAgentSession')).toHaveProperty('agentArgs', '--recorded-arguments')
})
