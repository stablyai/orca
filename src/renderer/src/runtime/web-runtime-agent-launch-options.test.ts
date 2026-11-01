import type { TuiAgent } from '../../../shared/tui-agent'
import type { SessionOptionValue } from '../../../shared/native-chat/input/native-chat-session-options'
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

type WebLaunchFixture = {
  name: string
  capable: boolean
  agent: TuiAgent
  options: Record<string, SessionOptionValue>
  raw: string
  tokens?: string[]
  authority?: { model: string; effort?: string }
  env?: Record<string, string>
}

const fixtures: WebLaunchFixture[] = [
  {
    name: 'capable Fast',
    capable: true,
    agent: 'claude',
    options: {
      model: 'private/sonnet',
      effort: 'high',
      permissionMode: 'accept-edits',
      fastMode: true
    },
    raw: `--settings '{"theme":"dark"}' --verbose`,
    tokens: [
      'claude',
      '--settings',
      '{"theme":"dark","fastMode":true}',
      '--verbose',
      '--model',
      'private/sonnet',
      '--effort',
      'high',
      '--permission-mode',
      'acceptEdits'
    ]
  },
  {
    name: 'older Fast',
    capable: false,
    agent: 'claude',
    options: {
      model: 'private/sonnet',
      effort: 'high',
      permissionMode: 'accept-edits',
      fastMode: true
    },
    raw: `--settings '{"theme":"dark"}' --verbose`,
    tokens: [
      'claude',
      '--settings',
      '{"theme":"dark","fastMode":true}',
      '--verbose',
      '--model',
      'private/sonnet',
      '--effort',
      'high',
      '--permission-mode',
      'acceptEdits'
    ]
  },
  {
    name: 'explicit off',
    capable: true,
    agent: 'claude',
    options: { model: 'sonnet', fastMode: false },
    raw: '--verbose',
    tokens: ['claude', '--verbose', '--model', 'sonnet', '--settings', '{"fastMode":false}']
  },
  {
    name: 'independent Speed',
    capable: true,
    agent: 'codex',
    options: { model: 'gpt-5.5', effort: 'high', serviceTier: 'priority' },
    raw: '--verbose',
    tokens: [
      'codex',
      '-c',
      'disable_paste_burst=true',
      '--verbose',
      '-m',
      'gpt-5.5',
      '-c',
      'model_reasoning_effort=high',
      '-c',
      'service_tier=priority'
    ]
  },
  {
    name: 'explicit default Speed',
    capable: true,
    agent: 'codex',
    options: { model: 'gpt-5.5', serviceTier: 'default' },
    raw: '--verbose',
    tokens: [
      'codex',
      '-c',
      'disable_paste_burst=true',
      '--verbose',
      '-m',
      'gpt-5.5',
      '-c',
      'service_tier=default'
    ]
  },
  {
    name: 'composed domain',
    capable: true,
    agent: 'cursor',
    options: { model: 'claude-opus-4-8', thinking: true, effort: 'high' },
    raw: '--verbose',
    authority: { model: 'claude-opus-4-8-thinking-high', effort: 'high' }
  },
  {
    name: 'model only',
    capable: true,
    agent: 'claude',
    options: { model: 'sonnet' },
    raw: '--verbose',
    authority: { model: 'sonnet' }
  },
  {
    name: 'effort only',
    capable: true,
    agent: 'claude',
    options: { effort: 'high' },
    raw: '--verbose',
    tokens: ['claude', '--verbose', '--effort', 'high']
  },
  {
    name: 'permission environment',
    capable: true,
    agent: 'goose',
    options: { permissionMode: 'full-access' },
    raw: '--verbose',
    tokens: ['goose', '--verbose'],
    env: { GOOSE_MODE: 'auto' }
  }
]

it.each(fixtures)('conserves $name through the actual web create adapter', async (fixture) => {
  stubTerminalCreateEnvironment(mocks)
  const capabilities = await import('@/components/settings/agent-launch-settings-transport')
  const preferences = await import('@/components/settings/use-host-agent-launch-preferences')
  const { RUNTIME_CAPABILITIES } = await import('../../../shared/protocol-version')
  const { resolveAgentStartupPlanInputs } =
    await import('../../../shared/agent-startup-plan-inputs')
  const { buildAgentStartupPlan } = await import('../../../shared/tui-agent-startup')
  const { tokenizeStartupCommand } = await import('../../../shared/tui-agent-startup-shell')
  const { launchAgentInWebHostTab } = await import('@/lib/launch-agent-web-host-tab')
  vi.spyOn(capabilities, 'hostSupportsLaunchChoices').mockResolvedValue(fixture.capable)
  vi.spyOn(preferences, 'ensureAgentLaunchPreferences').mockResolvedValue({
    defaultTuiAgent: undefined,
    disabledTuiAgents: undefined,
    agentLaunchChoices: {}
  })
  const call = vi.fn(async (request: { method: string }) => ({
    ok: true,
    result:
      request.method === 'status.get'
        ? {
            runtimeProtocolVersion: 3,
            minCompatibleRuntimeClientVersion: 2,
            capabilities: RUNTIME_CAPABILITIES
          }
        : request.method === 'session.tabs.list'
          ? { tabs: [], groups: [] }
          : {
              tab: { id: 'host-web-options', leafId: FOCUS_LEAF_ID },
              terminal: { handle: 'term-web', tabId: 'host-web-options', leafId: FOCUS_LEAF_ID }
            }
  }))
  stubRuntimeEnvironmentBridge({ call })
  try {
    const inputs = resolveAgentStartupPlanInputs({
      agent: fixture.agent,
      settings: { agentDefaultArgs: { claude: '--discarded-default' } },
      platform: 'linux',
      isRemote: true,
      shell: 'posix',
      agentArgs: fixture.raw,
      sessionOptions: fixture.options
    })
    const plan = buildAgentStartupPlan({ ...inputs, prompt: '', allowEmptyPromptLaunch: true })
    expect(plan).not.toBeNull()
    const outcome = await launchAgentInWebHostTab({
      agent: fixture.agent,
      worktreeId: WORKTREE_ID,
      environmentId: ENVIRONMENT_ID,
      activate: false,
      prompt: '',
      promptDelivery: 'auto-submit',
      sessionOptions: fixture.options,
      agentArgs: inputs.agentArgs,
      buildStartup: () => ({
        startupPlan: plan,
        pasteDraftAfterLaunch: null,
        submitPastedPrompt: false
      })
    })
    expect(outcome.outcome.status).toBe('created')
    if ('authority' in fixture) {
      expect(call).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'terminal.createAgentSession',
          params: expect.objectContaining({
            agent: fixture.agent,
            agentArgs: fixture.raw,
            launchPreferences: fixture.authority
          })
        })
      )
      expect(
        call.mock.calls.some(([request]) => request.method === 'session.tabs.createTerminal')
      ).toBe(false)
    } else {
      expect(
        call.mock.calls.some(([request]) => request.method === 'terminal.createAgentSession')
      ).toBe(false)
      const parsed = tokenizeStartupCommand(plan!.launchCommand, 'posix')
      expect(parsed.ok && parsed.tokens).toEqual(fixture.tokens)
      expect(call).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'session.tabs.createTerminal',
          params: expect.objectContaining({
            command: plan!.launchCommand,
            launchConfig: plan!.launchConfig,
            select: false,
            navigation: 'caller',
            ...('env' in fixture ? { env: expect.objectContaining(fixture.env) } : {})
          })
        })
      )
    }
  } finally {
    vi.restoreAllMocks()
    resetTerminalCreateEnvironment()
  }
})
