import { describe, expect, it } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import {
  hasExplicitTuiAgentArgs,
  hasExplicitTuiLaunchCustomization,
  hasSemanticallyNonEmptyAgentArgs,
  resolveAgentLaunchRoute
} from './agent-launch-routing'

const settings = {
  experimentalNativeChat: true,
  experimentalStructuredNativeChat: true,
  openAgentTabsInChatByDefault: true
}

function route(overrides: Partial<Parameters<typeof resolveAgentLaunchRoute>[0]> = {}) {
  return resolveAgentLaunchRoute({
    agent: 'codex',
    settings,
    executionHostId: 'local',
    platform: 'darwin',
    hostCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
    workspaceKind: 'git-worktree',
    nativeChatTranscriptIsLocalReadable: true,
    ...overrides
  })
}

describe('resolveAgentLaunchRoute', () => {
  it.each(['claude', 'codex'] as const)(
    'routes a supported local %s launch to structured native chat',
    (agent) => {
      expect(route({ agent })).toBe('structured-native-chat')
      expect(
        route({ agent, launchText: 'explain this change', promptDelivery: 'auto-submit' })
      ).toBe('structured-native-chat')
    }
  )

  /** Boundary guard between this lane and the one that owns Windows Codex. Codex's win32 refusal is
   *  deliberate, so it is asserted against whatever currently lets Claude through rather than
   *  against one host answer — a future gate swap must not be able to flip Codex on quietly. */
  describe("Codex's Windows refusal", () => {
    it('holds in the exact situation that routes Claude to structured', () => {
      const onWindows = { platform: 'win32' } as const
      expect(route({ ...onWindows, agent: 'claude' })).toBe('structured-native-chat')
      expect(route({ ...onWindows, agent: 'codex' })).toBe('legacy-native-chat')
    })

    it('holds for every host capability set, including ones that carry extra gates', () => {
      for (const hostCapabilities of [
        [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
        [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY, 'agent-session.structured.claude.v1'],
        [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY, 'agent-session.structured.hold.v1']
      ]) {
        expect(route({ agent: 'codex', platform: 'win32', hostCapabilities })).toBe(
          'legacy-native-chat'
        )
      }
    })

    it('holds for prompted and folder-workspace launches too', () => {
      expect(
        route({
          agent: 'codex',
          platform: 'win32',
          launchText: 'go',
          promptDelivery: 'auto-submit'
        })
      ).toBe('legacy-native-chat')
      expect(route({ agent: 'codex', platform: 'win32', workspaceKind: 'folder' })).toBe(
        'legacy-native-chat'
      )
    })
  })

  /** Pins Codex's whole platform answer, not just win32, so no platform silently changes here. */
  it.each([
    ['darwin', 'structured-native-chat'],
    ['linux', 'structured-native-chat'],
    ['win32', 'legacy-native-chat']
  ] as const)('leaves Codex routing on %s unchanged', (platform, expected) => {
    expect(route({ agent: 'codex', platform })).toBe(expected)
  })

  /** Claude's Windows answer is not a client-side platform guess: the route lets it through and the
   *  executing host settles it with agentSession.createSupport at create time. */
  it('lets a Windows Claude launch reach the host-measured create support check', () => {
    expect(route({ agent: 'claude', platform: 'win32' })).toBe('structured-native-chat')
  })

  it('routes a supported local Codex launch to structured native chat', () => {
    expect(route()).toBe('structured-native-chat')
    expect(route({ launchText: 'explain this change', promptDelivery: 'auto-submit' })).toBe(
      'structured-native-chat'
    )
  })

  it('keeps editable drafts on the terminal-backed native chat path', () => {
    expect(route({ launchText: 'reviewable context', promptDelivery: 'draft' })).toBe(
      'legacy-native-chat'
    )
  })

  it('preserves toggle-off and terminal-default behavior', () => {
    expect(route({ settings: { ...settings, experimentalStructuredNativeChat: false } })).toBe(
      'legacy-native-chat'
    )
    expect(route({ settings: { ...settings, openAgentTabsInChatByDefault: false } })).toBe(
      'terminal-tui'
    )
    expect(route({ settings: { ...settings, experimentalNativeChat: false } })).toBe('terminal-tui')
  })

  it('fails closed for missing capability, unsupported providers, and explicit TUI options', () => {
    expect(route({ hostCapabilities: [] })).toBe('legacy-native-chat')
    // openclaude and grok render native chat but have no structured adapter.
    expect(route({ agent: 'openclaude' })).toBe('legacy-native-chat')
    expect(route({ agent: 'grok' })).toBe('legacy-native-chat')
    expect(route({ requiresTuiLaunchCustomization: true })).toBe('legacy-native-chat')
    expect(route({ initialSessionOptions: { model: 'gpt-5.6-sol' } })).toBe('legacy-native-chat')
  })

  it.each([
    ['SSH', 'ssh:host-a'],
    ['paired runtime', 'runtime:environment-a']
  ])('preserves execution ownership on %s', (_name, executionHostId) => {
    expect(route({ executionHostId })).toBe('legacy-native-chat')
  })

  it.each(['git-worktree', 'folder'] as const)(
    'supports a local %s without widening floating-terminal scope',
    (workspaceKind) => {
      expect(route({ workspaceKind, platform: 'linux' })).toBe('structured-native-chat')
    }
  )

  it('keeps floating, WSL, and repair-required launches terminal-backed', () => {
    expect(route({ workspaceKind: 'floating' })).toBe('legacy-native-chat')
    expect(route({ agent: 'claude', workspaceKind: 'floating', platform: 'win32' })).toBe(
      'legacy-native-chat'
    )
    expect(
      route({
        projectRuntime: {
          status: 'resolved',
          runtime: {
            kind: 'wsl',
            hostPlatform: 'wsl',
            projectId: 'repo-1',
            distro: 'Ubuntu',
            reason: 'project-override',
            cacheKey: 'wsl'
          }
        }
      })
    ).toBe('legacy-native-chat')
    expect(
      route({
        projectRuntime: {
          status: 'repair-required',
          repair: {
            projectId: 'repo-1',
            preferredRuntime: { kind: 'wsl', distro: null },
            reason: 'wsl-distro-required',
            source: 'project-override',
            cacheKey: 'repair'
          }
        }
      })
    ).toBe('legacy-native-chat')
  })

  it('normalizes semantically empty argument and settings customization', () => {
    expect(hasSemanticallyNonEmptyAgentArgs('  \n\t')).toBe(false)
    expect(
      hasExplicitTuiLaunchCustomization(
        { agentCmdOverrides: {}, agentDefaultArgs: { codex: '   ' }, agentDefaultEnv: {} },
        'codex'
      )
    ).toBe(false)
  })

  it('does not classify the resolved default TUI args as customization', () => {
    expect(hasExplicitTuiAgentArgs('codex', '--dangerously-bypass-approvals-and-sandbox')).toBe(
      false
    )
    expect(hasExplicitTuiAgentArgs('codex', '--model gpt-5.6-sol')).toBe(true)
  })
})
