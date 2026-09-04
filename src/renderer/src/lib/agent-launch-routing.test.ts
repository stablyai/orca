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
    expect(route({ agent: 'claude' })).toBe('legacy-native-chat')
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

  it('keeps floating, Windows, WSL, and repair-required launches terminal-backed', () => {
    expect(route({ workspaceKind: 'floating' })).toBe('legacy-native-chat')
    expect(route({ platform: 'win32' })).toBe('legacy-native-chat')
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
