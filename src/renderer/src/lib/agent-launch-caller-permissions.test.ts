// Permission bypass lives only in the arguments string; verify each caller’s final argv so it cannot be silently lost.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  callerProfileCases,
  type AgentLaunchCallerProfile
} from './agent-launch-caller-profiles-test-harness'
import {
  createLaunchFunnelStore,
  hostLaunchRequest,
  queuedStartupCommand,
  queuedStartupPayload,
  resetLaunchFunnelStore
} from './agent-launch-funnel-test-harness'
import { newTabPromptLaunchesThroughHost } from './launch-agent-new-tab-host-route'

const store = createLaunchFunnelStore()

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'darwin' }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdFromState: () => null }))
vi.mock('@/lib/native-chat-transcript-readability', () => ({
  isNativeChatTranscriptLocalReadable: () => true
}))
vi.mock('@/runtime/web-runtime-session-environment', () => ({
  isWebRuntimeSessionActive: () => false
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => 'local',
  runtimeEnvironmentIdOrLocalUnlessTwin: () => null
}))
vi.mock('@/components/tab-bar/reconcile-order', () => ({
  reconcileTabOrder: (_stored: unknown, terminalIds: string[]) => terminalIds
}))
vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))
vi.mock('@/components/native-chat/native-chat-session-option-cache', () => ({
  seedNativeChatAppliedSessionOptions: vi.fn()
}))
vi.mock('@/lib/agent-paste-draft', () => ({ pasteDraftWhenAgentReady: vi.fn(async () => true) }))
vi.mock('@/lib/agent-ready-wait', () => ({
  waitForAgentReady: vi.fn(async () => ({ ready: true, reason: 'foreground-match' }))
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilitiesOrUnknown: () => []
}))
// A launch the host delivers waits on its reply; these tests read only what was sent.
const callRuntimeRpc = vi.hoisted(() => vi.fn(() => new Promise(() => {})))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc }))
vi.mock('@/runtime/runtime-rpc-result', () => ({ RuntimeRpcCallError: Error }))

function launchesThroughHost(profile: AgentLaunchCallerProfile): boolean {
  return newTabPromptLaunchesThroughHost({
    promptDelivery: profile.args.promptDelivery ?? 'auto-submit',
    pastesPrompt: (profile.args.prompt?.trim() ?? '').length > 0,
    isRemote: false
  })
}

// Host-delivered prompts use request arguments; absence inherits settings, including shipped bypass defaults.
function expectHostRequestArguments(profile: AgentLaunchCallerProfile): void {
  const request = hostLaunchRequest(store)
  expect(queuedStartupCommand(store)).toBeUndefined()
  if (profile.args.agentArgs === undefined) {
    expect(request).not.toHaveProperty('agentArgs')
  } else {
    expect(request?.agentArgs).toBe(profile.args.agentArgs)
  }
}

const CODEX_BYPASS = '--dangerously-bypass-approvals-and-sandbox'

/** One agent per prompt-injection mode, with the bypass flag Orca ships as that agent's default. */
const BYPASS_BY_AGENT: readonly [TuiAgent, string, string][] = [
  ['codex', 'argv', CODEX_BYPASS],
  ['claude', 'argv', '--dangerously-skip-permissions'],
  ['gemini', 'flag-prompt-interactive', '--yolo'],
  ['copilot', 'flag-interactive', '--yolo'],
  ['hermes', 'hermes-query', '--yolo'],
  ['amp', 'stdin-after-start', '--dangerously-allow-all']
]

const cases = callerProfileCases()

async function launch(profile: AgentLaunchCallerProfile) {
  const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
  return launchAgentInNewTab({ requestId: 'request-1', ...profile.args })
}

describe('agent launch caller arguments and permission bypass', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetLaunchFunnelStore(store)
  })

  it.each(cases)('puts %s on the command line its own arguments describe', async (_id, profile) => {
    await launch(profile)
    if (launchesThroughHost(profile)) {
      expectHostRequestArguments(profile)
      return
    }

    const command = queuedStartupCommand(store)
    expect(command).toBeDefined()
    // Explicit arguments replace shipped defaults; absent arguments inherit them on the queued command.
    const args = profile.args.agentArgs === undefined ? `'${CODEX_BYPASS}'` : "'--model' 'gpt-5.5'"
    // Quick-command alone supplies a prompt without a delivery mode, invoking auto-submit and argv injection.
    const argvPrompt = profile.id === 'quick-command' ? ` '${profile.args.prompt}'` : ''
    expect(command).toBe(`codex ${args}${argvPrompt}`)
  })

  it.each(cases)('keeps %s on the bypass posture its arguments encode', async (_id, profile) => {
    await launch(profile)
    if (launchesThroughHost(profile)) {
      expectHostRequestArguments(profile)
      return
    }

    const command = queuedStartupCommand(store) ?? ''
    // Saved recipe arguments replace defaults; a recipe without a bypass flag must launch without it.
    const namesOwnArguments = profile.args.agentArgs !== undefined
    expect(command.includes(CODEX_BYPASS)).toBe(!namesOwnArguments)
  })

  it.each(cases)(
    'forwards an explicit argument override from %s to the tab',
    async (_id, profile) => {
      await launch(profile)
      if (launchesThroughHost(profile)) {
        expectHostRequestArguments(profile)
        return
      }

      const payload = queuedStartupPayload(store)
      if (profile.args.agentArgs === undefined) {
        // Forward overrides only when named so the tab can distinguish inheritance from explicit arguments.
        expect(payload).not.toHaveProperty('agentArgsOverride')
      } else {
        expect(payload?.agentArgsOverride).toBe(profile.args.agentArgs)
      }
    }
  )

  it.each(BYPASS_BY_AGENT)(
    'ships %s (%s) with its permission-bypass flag when no call site names arguments',
    async (agent, _mode, bypassFlag) => {
      const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

      launchAgentInNewTab({ requestId: 'request-2', agent, worktreeId: 'wt-1' })

      expect(queuedStartupCommand(store)).toContain(bypassFlag)
    }
  )

  it.each(BYPASS_BY_AGENT)(
    'drops the bypass flag for %s when the user stored Manual arguments',
    async (agent, _mode, bypassFlag) => {
      store.settings = { ...store.settings, agentDefaultArgs: { [agent]: '' } }
      const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

      launchAgentInNewTab({ requestId: 'request-3', agent, worktreeId: 'wt-1' })

      // A stored empty string owns the key, so it beats the shipped bypass default.
      expect(queuedStartupCommand(store)).not.toContain(bypassFlag)
    }
  )

  it('carries a bypass posture that lives in the environment rather than in argv', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ requestId: 'request-4', agent: 'goose', worktreeId: 'wt-1' })

    // Goose bypass defaults use an env var; argv-only migration would silently change permissions.
    expect(queuedStartupPayload(store)?.env).toEqual({ GOOSE_MODE: 'auto' })
  })

  it('restores the shipped bypass default when a caller passes agentArgs as undefined', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      requestId: 'request-5',
      agent: 'codex',
      worktreeId: 'wt-1',
      agentArgs: undefined
    })

    // Characterize current behavior: explicit undefined inherits shipped bypass defaults like an omitted key, rather than clearing arguments.
    expect(queuedStartupCommand(store)).toBe(`codex '${CODEX_BYPASS}'`)
    expect(queuedStartupPayload(store)).not.toHaveProperty('agentArgsOverride')
  })

  it('launches without any arguments when a caller passes agentArgs as null', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      requestId: 'request-6',
      agent: 'codex',
      worktreeId: 'wt-1',
      agentArgs: null
    })

    expect(queuedStartupCommand(store)).toBe('codex')
    expect(queuedStartupPayload(store)?.agentArgsOverride).toBeNull()
  })

  it('lets a per-launch argument beat the stored setting', async () => {
    store.settings = { ...store.settings, agentDefaultArgs: { codex: '--model stored' } }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      requestId: 'request-7',
      agent: 'codex',
      worktreeId: 'wt-1',
      agentArgs: '--model per-launch'
    })

    expect(queuedStartupCommand(store)).toBe("codex '--model' 'per-launch'")
  })

  it('carries the stored launch environment onto the queued tab', async () => {
    store.settings = { ...store.settings, agentDefaultEnv: { codex: { CODEX_PROFILE: 'team' } } }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ requestId: 'request-8', agent: 'codex', worktreeId: 'wt-1' })

    const payload = queuedStartupPayload(store)
    expect(payload?.env).toEqual({ CODEX_PROFILE: 'team' })
    expect(payload?.launchConfig).toMatchObject({
      agentArgs: CODEX_BYPASS,
      agentEnv: { CODEX_PROFILE: 'team' }
    })
  })

  // Composer picks seed structured creates only; terminal fallbacks must not receive them (launch-structured-agent-session tests).
  it.each([
    [true, undefined, CODEX_BYPASS],
    [false, undefined, CODEX_BYPASS],
    [true, '--search', '--search'],
    [false, '--search', '--search']
  ])(
    'keeps remembered model and effort off a terminal fallback (Chat UI %s, stored args %s)',
    async (chatUi, storedArgs, expectedArgs) => {
      store.settings = {
        ...store.settings,
        experimentalNativeChat: chatUi,
        ...(storedArgs === undefined ? {} : { agentDefaultArgs: { codex: storedArgs } }),
        nativeChatSessionOptions: {
          codex: {
            model: 'gpt-5.2-codex',
            valuesByModel: { 'gpt-5.2-codex': { effort: 'medium' } }
          }
        }
      }
      const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

      const result = launchAgentInNewTab({
        requestId: 'request-9',
        agent: 'codex',
        worktreeId: 'wt-1'
      })

      expect(result?.startupPlan?.sessionOptions).toBeUndefined()
      const command = queuedStartupCommand(store)
      expect(command).not.toContain("'-m'")
      expect(command).not.toContain('model_reasoning_effort')
      expect(command).toBe(`codex '${expectedArgs}'`)
    }
  )
})
