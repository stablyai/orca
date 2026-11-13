// CLOUD-HELD-SURFACE (END-PASS n49): the real composer hands its create the agent menu's choice.
// With Orca Cloud selected the menu has no host to ask, so that choice says "terminal" whatever the
// person prefers (Settings › Chat UI). A VM create's route is decided here unless a surface was picked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/agent-session/agent-session-runtime-capabilities'
import type { AgentLaunchRouteStore } from '@/lib/agent-session/launch/routing/agent-launch-route-input'
import type { AgentLaunchChoice } from '@/lib/agent-session/launch/routing/agent-menu-selection'
import { composerCreateLaunchRoute } from './composer-create-launch-route'

vi.mock('@/runtime/hosts/preflight/local-preflight-context', () => ({
  getLocalProjectExecutionRuntimeContext: () => undefined,
  getLocalRepoProjectExecutionRuntimeContext: () => undefined
}))
vi.mock('@/app-shell/platform/web-client-location', () => ({ isWebClientLocation: () => false }))
vi.mock('@/runtime/hosts/capabilities/local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilitiesOrUnknown: () => [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
  awaitLocalRuntimeCapabilities: async () => undefined
}))
vi.mock('@/lib/agent-session/launch/continuation/structured-agent-launch-settlement', () => ({}))

// What Settings › Chat UI › "Turn on" writes, with Claude set to Chat.
const CHAT_UI_ON = {
  agentDefaultSurface: 'chat',
  nativeChatProviders: { claude: true },
  agentCmdOverrides: {},
  agentDefaultArgs: {},
  agentDefaultEnv: {}
}
const store = (settings: Record<string, unknown>): AgentLaunchRouteStore =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a route store with only the settings the route reads
  ({ settings }) as unknown as AgentLaunchRouteStore

// The agent menu with no host to ask (agentRows null for a VM create): answer 'no-chats'.
const MENU_NO_HOST: AgentLaunchChoice = {
  agent: 'claude',
  route: 'terminal-tui',
  executionHostId: 'local'
}
const create = (
  vmRecipeId: string | undefined,
  launchChoice: AgentLaunchChoice | undefined = MENU_NO_HOST
) => ({
  agent: 'claude' as const,
  launchChoice,
  vmRecipeId,
  workspace: { kind: 'git-worktree' as const, repoId: 'hello-world' },
  prompt: '',
  promptDelivery: 'auto-submit' as const
})

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  warn.mockRestore()
})

describe('composerCreateLaunchRoute', () => {
  it('Orca Cloud with Chat UI on: a chat, even though the menu said terminal', () => {
    expect(composerCreateLaunchRoute(store(CHAT_UI_ON), create('cloud'))).toBe(
      'structured-native-chat'
    )
  })

  it('Orca Cloud with Chat UI off: a terminal', () => {
    expect(
      composerCreateLaunchRoute(
        store({ ...CHAT_UI_ON, agentDefaultSurface: 'terminal', nativeChatProviders: {} }),
        create('cloud')
      )
    ).toBe('terminal-tui')
  })

  it('Claude set to Terminal in Chat UI (others on Chat): an Orca Cloud create stays a terminal', () => {
    expect(
      composerCreateLaunchRoute(
        store({ ...CHAT_UI_ON, nativeChatProviders: { claude: false } }),
        create('cloud')
      )
    ).toBe('terminal-tui')
  })

  it('an explicit Terminal pick on a VM create is kept (requestedSurface terminal)', () => {
    const picked: AgentLaunchChoice = { ...MENU_NO_HOST, requestedSurface: 'terminal' }
    expect(composerCreateLaunchRoute(store(CHAT_UI_ON), create('cloud', picked))).toBe(
      'terminal-tui'
    )
  })

  it('another VM recipe (no image list): a terminal, and the downgrade is logged', () => {
    expect(composerCreateLaunchRoute(store(CHAT_UI_ON), create('custom-vm'))).toBe('terminal-tui')
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        '[agent-launch-route] claude opens terminal-tui: runtime-capability-unknown'
      )
    )
  })

  it('a create on an existing host keeps the menu choice (it asked that host)', () => {
    const local: AgentLaunchChoice = {
      agent: 'claude',
      route: 'structured-native-chat',
      executionHostId: 'local'
    }
    expect(composerCreateLaunchRoute(store(CHAT_UI_ON), create(undefined, local))).toBe(
      'structured-native-chat'
    )
    expect(composerCreateLaunchRoute(store(CHAT_UI_ON), create(undefined))).toBe('terminal-tui')
  })

  it('no agent: a terminal', () => {
    expect(composerCreateLaunchRoute(store(CHAT_UI_ON), { ...create('cloud'), agent: null })).toBe(
      'terminal-tui'
    )
  })
})
