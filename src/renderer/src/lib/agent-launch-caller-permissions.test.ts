// What each call site's arguments resolve to on the launch command line, and whether the
// permission-bypass flag survives. The bypass bit has no storage of its own — it lives inside the
// arguments string — so losing it here is silent and security-relevant.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  callerProfileCases,
  type AgentLaunchCallerProfile
} from './agent-launch-caller-profiles-test-harness'
import {
  createLaunchFunnelStore,
  queuedStartupCommand,
  queuedStartupPayload,
  resetLaunchFunnelStore
} from './agent-launch-funnel-test-harness'

const store = createLaunchFunnelStore()

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'darwin' }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdFromState: () => null }))
vi.mock('@/lib/native-chat-transcript-readability', () => ({
  isNativeChatTranscriptLocalReadable: () => true
}))
vi.mock('@/runtime/web-runtime-session', () => ({ isWebRuntimeSessionActive: () => false }))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => 'local',
  getRuntimeEnvironmentIdForWorktree: () => null
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
  return launchAgentInNewTab({ ...profile.args })
}

describe('agent launch caller arguments and permission bypass', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetLaunchFunnelStore(store)
  })

  it.each(cases)('puts %s on the command line its own arguments describe', async (_id, profile) => {
    await launch(profile)

    const command = queuedStartupCommand(store)
    expect(command).toBeDefined()
    // A call site that names arguments replaces the shipped default outright; one that names none
    // inherits it. Both shapes must stay visible on the queued command.
    const args = profile.args.agentArgs === undefined ? `'${CODEX_BYPASS}'` : "'--model' 'gpt-5.5'"
    // Why: quick-command is the ONE call site that carries a prompt and names no delivery mode, so
    // it takes the default auto-submit path and folds the prompt into argv for an argv agent.
    const argvPrompt = profile.id === 'quick-command' ? ` '${profile.args.prompt}'` : ''
    expect(command).toBe(`codex ${args}${argvPrompt}`)
  })

  it.each(cases)('keeps %s on the bypass posture its arguments encode', async (_id, profile) => {
    await launch(profile)

    const command = queuedStartupCommand(store) ?? ''
    // Why: the three recipe-driven call sites hand in saved arguments, which REPLACE the shipped
    // default rather than merging with it — a saved recipe without the flag launches without bypass.
    const namesOwnArguments = profile.args.agentArgs !== undefined
    expect(command.includes(CODEX_BYPASS)).toBe(!namesOwnArguments)
  })

  it.each(cases)(
    'forwards an explicit argument override from %s to the tab',
    async (_id, profile) => {
      await launch(profile)

      const payload = queuedStartupPayload(store)
      if (profile.args.agentArgs === undefined) {
        // Why: the funnel forwards `agentArgsOverride` only when the caller named arguments, so the
        // tab can tell "inherit the setting" apart from "this launch chose these".
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

      launchAgentInNewTab({ agent, worktreeId: 'wt-1' })

      expect(queuedStartupCommand(store)).toContain(bypassFlag)
    }
  )

  it.each(BYPASS_BY_AGENT)(
    'drops the bypass flag for %s when the user stored Manual arguments',
    async (agent, _mode, bypassFlag) => {
      store.settings = { ...store.settings, agentDefaultArgs: { [agent]: '' } }
      const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

      launchAgentInNewTab({ agent, worktreeId: 'wt-1' })

      // A stored empty string owns the key, so it beats the shipped bypass default.
      expect(queuedStartupCommand(store)).not.toContain(bypassFlag)
    }
  )

  it('carries a bypass posture that lives in the environment rather than in argv', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'goose', worktreeId: 'wt-1' })

    // Goose has no bypass flag; its default posture is an env var, and a migration that carried
    // only argv would silently downgrade it.
    expect(queuedStartupPayload(store)?.env).toEqual({ GOOSE_MODE: 'auto' })
  })

  it('restores the shipped bypass default when a caller passes agentArgs as undefined', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1', agentArgs: undefined })

    // Characterized, not endorsed: an explicit `undefined` is indistinguishable from an omitted
    // key here, so a caller that resolved "apply no saved arguments" to `undefined` gets the
    // shipped bypass default back instead of launching without it.
    expect(queuedStartupCommand(store)).toBe(`codex '${CODEX_BYPASS}'`)
    expect(queuedStartupPayload(store)).not.toHaveProperty('agentArgsOverride')
  })

  it('launches without any arguments when a caller passes agentArgs as null', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1', agentArgs: null })

    expect(queuedStartupCommand(store)).toBe('codex')
    expect(queuedStartupPayload(store)?.agentArgsOverride).toBeNull()
  })

  it('lets a per-launch argument beat the stored setting', async () => {
    store.settings = { ...store.settings, agentDefaultArgs: { codex: '--model stored' } }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1', agentArgs: '--model per-launch' })

    expect(queuedStartupCommand(store)).toBe("codex '--model' 'per-launch'")
  })

  it('carries the stored launch environment onto the queued tab', async () => {
    store.settings = { ...store.settings, agentDefaultEnv: { codex: { CODEX_PROFILE: 'team' } } }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })

    const payload = queuedStartupPayload(store)
    expect(payload?.env).toEqual({ CODEX_PROFILE: 'team' })
    expect(payload?.launchConfig).toMatchObject({
      agentArgs: CODEX_BYPASS,
      agentEnv: { CODEX_PROFILE: 'team' }
    })
  })

  it('applies a remembered model and effort to the launch command', async () => {
    store.settings = {
      ...store.settings,
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: true,
      nativeChatSessionOptions: {
        codex: { model: 'gpt-5.2-codex', valuesByModel: { 'gpt-5.2-codex': { effort: 'medium' } } }
      }
    }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })

    expect(result?.startupPlan.sessionOptions).toEqual({
      model: 'gpt-5.2-codex',
      effort: 'medium'
    })
    expect(queuedStartupCommand(store)).toContain("'-m' 'gpt-5.2-codex'")
    expect(queuedStartupCommand(store)).toContain("'-c' 'model_reasoning_effort=medium'")
    // The remembered options ride beside the bypass default rather than replacing it.
    expect(queuedStartupCommand(store)).toContain(CODEX_BYPASS)
  })

  it('keeps remembered session options out of a plain terminal launch', async () => {
    store.settings = {
      ...store.settings,
      nativeChatSessionOptions: {
        codex: { model: 'gpt-5.2-codex', valuesByModel: { 'gpt-5.2-codex': { effort: 'medium' } } }
      }
    }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })

    expect(result?.startupPlan.sessionOptions).toBeUndefined()
    expect(queuedStartupCommand(store)).not.toContain("'-m'")
  })
})
