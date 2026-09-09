import { describe, expect, it } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import {
  hasExplicitTuiAgentArgs,
  hasExplicitTuiLaunchCustomization,
  hasSemanticallyNonEmptyAgentArgs,
  resolveAgentLaunchRoute,
  structuredAgentLaunchSupported
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
      expect(route({ agent, initialSessionOptions: { model: 'gpt-5.6-sol' } })).toBe(
        'structured-native-chat'
      )
      expect(
        route({ agent, launchText: 'explain this change', promptDelivery: 'auto-submit' })
      ).toBe('structured-native-chat')
    }
  )

  /** Windows eligibility is no client-side platform guess for either provider: the route lets the
   *  launch through and the executing host settles it with agentSession.createSupport at create
   *  time. A stale caller still passing the removed `platform` input must not flip Codex off the
   *  structured route — the field is gone, not reinterpreted. */
  it.each(['claude', 'codex'] as const)(
    'routes %s to structured even when the caller claims a win32 client platform',
    (agent) => {
      expect(route({ agent, ...({ platform: 'win32' } as object) })).toBe('structured-native-chat')
    }
  )

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
    expect(route({ hostCapabilities: null })).toBe('legacy-native-chat')
    // openclaude and grok render native chat but have no structured adapter.
    expect(route({ agent: 'openclaude' })).toBe('legacy-native-chat')
    expect(route({ agent: 'grok' })).toBe('legacy-native-chat')
    expect(route({ requiresTuiLaunchCustomization: true })).toBe('legacy-native-chat')
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
      expect(route({ workspaceKind })).toBe('structured-native-chat')
    }
  )

  it('keeps floating, WSL, and repair-required launches terminal-backed', () => {
    expect(route({ workspaceKind: 'floating' })).toBe('legacy-native-chat')
    expect(route({ agent: 'claude', workspaceKind: 'floating' })).toBe('legacy-native-chat')
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

describe('explicit structured chat requests', () => {
  it.each(['claude', 'codex'] as const)(
    'supports %s history resume when new tabs default to terminal',
    (agent) => {
      const input = {
        agent,
        settings: { ...settings, openAgentTabsInChatByDefault: false },
        executionHostId: 'local',
        platform: 'darwin' as const,
        hostCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
        workspaceKind: 'folder' as const
      }
      expect(resolveAgentLaunchRoute(input)).toBe('terminal-tui')
      expect(structuredAgentLaunchSupported(input)).toBe(true)
      expect(structuredAgentLaunchSupported({ ...input, hostCapabilities: [] })).toBe(false)
      expect(
        structuredAgentLaunchSupported({
          ...input,
          settings: { ...input.settings, experimentalStructuredNativeChat: false }
        })
      ).toBe(false)
    }
  )
})
