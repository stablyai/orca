// @vitest-environment happy-dom
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, expect, vi, type Mock } from 'vitest'
import { resetWebSessionCloseIntentForTests } from './web-session-close-intent'
import {
  WORKTREE_ID,
  FOCUS_LEAF_ID,
  ENVIRONMENT_ID,
  makeSnapshot,
  resetTerminalCreateEnvironment,
  stubTerminalCreateEnvironment
} from './web-runtime-session-test-harness'
import { stubRuntimeEnvironmentBridge } from './runtime-environment-bridge-fixture'

type LaunchMocks = {
  launched: Mock<typeof launch>
  observation: Mock
  picker: Mock
  getState: Mock
  setState: Mock
  subscribe: Mock
  setActiveWorktree: Mock
  createBrowserTab: Mock
  closeEmptyGroup: Mock
  moveUnifiedTabToGroup: Mock
  setRemoteBrowserPageHandle: Mock
  focusBrowserTabInWorktree: Mock
  applyWebSessionTabsSnapshot: Mock
  decideWebSessionTabsSnapshot: Mock
  getWebSessionTabsTrackingGeneration: Mock
  acceptReplayedWebSessionTabsSnapshot: Mock
  resolveHostSessionTabIdForWebSessionTab: Mock
  trackTerminalPaneSplit: Mock
  deliverLaunchPromptToAgentTab: Mock
  seedNativeChatLaunchDraftForAgentTab: Mock
  hasMaterializedWebRuntimeBrowserPage: Mock
  toastError: Mock
}

const mocks: LaunchMocks = vi.hoisted(() => ({
  launched: vi.fn<typeof launch>(),
  observation: vi.fn(),
  picker: vi.fn(),
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
  useAppStore: Object.assign((select: (state: unknown) => unknown) => select(mocks.getState()), {
    getState: mocks.getState,
    setState: mocks.setState,
    subscribe: mocks.subscribe
  })
}))

vi.mock('@/components/tab-bar/use-new-tab-agent-menu-rows', () => ({
  useAgentMenuObservation: mocks.observation
}))
vi.mock('@/hooks/useAgentDetectionTarget', () => ({
  useAgentDetectionTargetForWorktree: () => null
}))
vi.mock('@/components/agent/AgentLaunchPicker', () => ({ AgentLaunchPicker: mocks.picker }))
vi.mock('@/lib/host-chat-program', () => ({ agentsOfferedForLaunch: () => ['claude'] }))
vi.mock('@/lib/host-chat-program-acquisition', () => ({
  acquireAgentLaunchChoices: async () => ({ detected: ['claude'], offered: ['claude'] })
}))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: (input: Parameters<typeof launch>[0]) => {
    const terminalCompletion = mocks.launched(input)
    return { surface: { kind: 'host-published' }, terminalCompletion }
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

vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: vi.fn() } }))

afterEach(() => resetWebSessionCloseIntentForTests())

import { launchAgentInWebHostTab } from '@/lib/launch-agent-web-host-tab'
import { planLaunchAgentStartupPrompt } from '@/lib/launch-agent-startup-prompt-plan'
import { resolveAgentStartupPlanInputs } from '../../../shared/agent-launch/startup/agent-startup-plan-inputs'
import { projectAgentLaunchSettings } from '../../../shared/agent-launch/choices/agent-launch-settings'
import * as preferences from './agent-launch-settings/use-host-agent-launch-preferences'
import * as settingsTransport from './agent-launch-settings/agent-launch-settings-transport'

export const host: { capabilities: string[]; refusal?: string } = { capabilities: [] }
export const call = vi.fn(async (request: { method: string; params?: Record<string, unknown> }) => {
  if (request.method === 'status.get') {
    return {
      ok: true,
      result: {
        runtimeProtocolVersion: 3,
        minCompatibleRuntimeClientVersion: 2,
        capabilities: host.capabilities
      }
    }
  }
  if (request.method === 'terminal.createAgentSession' && host.refusal) {
    return { ok: false, error: { code: host.refusal, message: 'Use legacy creation' } }
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
  host.capabilities = ['agent-session.host-authority.v1', 'agent-session.create-options.v1']
  host.refusal = undefined
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
  cleanup()
  vi.restoreAllMocks()
  resetTerminalCreateEnvironment()
})

export function launch(input: Partial<Parameters<typeof launchAgentInWebHostTab>[0]> = {}) {
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
export function params(method: string) {
  const request = call.mock.calls.find(([request]) => request.method === method)?.[0]
  expect(request).toBeDefined()
  return request!.params!
}

export { mocks }
