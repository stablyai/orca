// What each call site's arguments resolve to on the launch command line, and whether the
// permission-bypass flag follows the agent's typed permission mode. Losing the flag here is silent
// and security-relevant, and so is adding it against a Manual setting.

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
  return launchAgentInNewTab({ requestId: 'request-1', ...profile.args })
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
    // A call site that names arguments replaces the configured extra text, not the permission
    // mode; one that names none inherits both. Both shapes must stay visible on the queued command.
    const args =
      profile.args.agentArgs === undefined
        ? `'${CODEX_BYPASS}'`
        : `'${CODEX_BYPASS}' '--model' 'gpt-5.5'`
    // Why: quick-command is the ONE call site that carries a prompt and names no delivery mode, so
    // it takes the default auto-submit path and folds the prompt into argv for an argv agent.
    const argvPrompt = profile.id === 'quick-command' ? ` '${profile.args.prompt}'` : ''
    expect(command).toBe(`codex ${args}${argvPrompt}`)
  })

  it.each(cases)('keeps %s on the Yolo posture the setting chose', async (_id, profile) => {
    await launch(profile)

    // Why: recipe-driven call sites hand in their own arguments; before the mode was typed those
    // replaced the stored flag and silently dropped bypass.
    expect(queuedStartupCommand(store)).toContain(CODEX_BYPASS)
  })

  it.each(cases)('keeps %s on the Manual posture the setting chose', async (_id, profile) => {
    store.settings = { ...store.settings, agentPermissionModeOverrides: { codex: 'ask' } }
    await launch(profile)

    expect(queuedStartupCommand(store) ?? '').not.toContain(CODEX_BYPASS)
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
        // Why composed: a paired host launches this override as-is.
        expect(payload?.agentArgsOverride).toBe(`${CODEX_BYPASS} ${profile.args.agentArgs}`)
      }
    }
  )

  // Source Control and fix-checks bring their own arguments; they follow the agent's effective
  // mode (what its card shows), so Arguments that ask keep asking and an alias Yolo stays Yolo.
  it.each(
    cases
      .filter(([id]) => id === 'source-control-action' || id === 'fix-checks')
      .flatMap(([id, profile]) =>
        (
          [
            ['codex', '-a on-request', CODEX_BYPASS, false],
            ['claude', '--permission-mode acceptEdits', '--dangerously-skip-permissions', false],
            ['gemini', '-y', '--yolo', true]
          ] as const
        ).map(
          ([agent, configured, flag, flagged]) =>
            [id, agent, configured, flag, flagged, profile] as const
        )
      )
  )(
    '%s launches %s configured %j under Yolo with its effective mode',
    async (_id, agent, configured, flag, flagged, profile) => {
      store.settings = { ...store.settings, agentDefaultArgs: { [agent]: configured } }
      const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

      launchAgentInNewTab({ requestId: 'request-11', ...profile.args, agent })

      const command = queuedStartupCommand(store) ?? ''
      expect(command.includes(`'${flag}'`) || command.includes(` ${flag}`)).toBe(flagged)
      expect(command).toContain('gpt-5.5')
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
    'drops the bypass flag for %s when its permission mode is Manual',
    async (agent, _mode, bypassFlag) => {
      store.settings = { ...store.settings, agentPermissionModeOverrides: { [agent]: 'ask' } }
      const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

      launchAgentInNewTab({ requestId: 'request-3', agent, worktreeId: 'wt-1' })

      expect(queuedStartupCommand(store)).not.toContain(bypassFlag)
    }
  )

  it('carries a bypass posture that lives in the environment rather than in argv', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ requestId: 'request-4', agent: 'goose', worktreeId: 'wt-1' })

    // Goose has no bypass flag; its default posture is an env var, and a migration that carried
    // only argv would silently downgrade it.
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

    // Characterized, not endorsed: an explicit `undefined` is indistinguishable from an omitted
    // key here, so a caller that resolved "apply no saved arguments" to `undefined` gets the
    // shipped bypass default back instead of launching without it.
    expect(queuedStartupCommand(store)).toBe(`codex '${CODEX_BYPASS}'`)
    expect(queuedStartupPayload(store)).not.toHaveProperty('agentArgsOverride')
  })

  it('launches with no extra arguments, but the mode, when a caller passes agentArgs as null', async () => {
    store.settings = { ...store.settings, agentDefaultArgs: { codex: '--model stored' } }
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      requestId: 'request-6',
      agent: 'codex',
      worktreeId: 'wt-1',
      agentArgs: null
    })

    expect(queuedStartupCommand(store)).toBe(`codex '${CODEX_BYPASS}'`)
    expect(queuedStartupPayload(store)?.agentArgsOverride).toBe(CODEX_BYPASS)
  })

  it('does not repeat a bypass flag the caller already typed', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      requestId: 'request-12',
      agent: 'codex',
      worktreeId: 'wt-1',
      agentArgs: `${CODEX_BYPASS} -m o3`
    })

    // Why: clap rejects a repeated flag, so a doubled one would fail the launch.
    expect(queuedStartupCommand(store)).toBe(`codex '${CODEX_BYPASS}' '-m' 'o3'`)
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

    expect(queuedStartupCommand(store)).toBe(`codex '${CODEX_BYPASS}' '--model' 'per-launch'`)
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

    const result = launchAgentInNewTab({
      requestId: 'request-9',
      agent: 'codex',
      worktreeId: 'wt-1'
    })

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

    const result = launchAgentInNewTab({
      requestId: 'request-10',
      agent: 'codex',
      worktreeId: 'wt-1'
    })

    expect(result?.startupPlan.sessionOptions).toBeUndefined()
    expect(queuedStartupCommand(store)).not.toContain("'-m'")
  })
})
