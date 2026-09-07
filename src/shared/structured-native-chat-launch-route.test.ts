/**
 * The shared half of the launch route: the renderer's `resolveAgentLaunchRoute` and orchestration's
 * worker-mode decision both answer from these, so a change here moves both surfaces at once.
 */

import { describe, expect, it } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from './protocol-version'
import {
  agentTabsDefaultToNativeChat,
  prefersStructuredNativeChatByDefault,
  resolveStructuredNativeChatSupport,
  type StructuredNativeChatSupportInput
} from './structured-native-chat-launch-route'

const ON = {
  experimentalNativeChat: true,
  openAgentTabsInChatByDefault: true,
  experimentalStructuredNativeChat: true
}

function support(overrides: Partial<StructuredNativeChatSupportInput> = {}) {
  return resolveStructuredNativeChatSupport({
    agent: 'claude',
    executionHostId: 'local',
    platform: 'darwin',
    hostCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
    workspaceKind: 'git-worktree',
    ...overrides
  })
}

describe('the settings default', () => {
  it('needs all three toggles for structured, and the first two for native chat', () => {
    expect(prefersStructuredNativeChatByDefault(ON)).toBe(true)
    expect(prefersStructuredNativeChatByDefault({ ...ON, experimentalNativeChat: false })).toBe(
      false
    )
    expect(
      prefersStructuredNativeChatByDefault({ ...ON, openAgentTabsInChatByDefault: false })
    ).toBe(false)
    expect(
      prefersStructuredNativeChatByDefault({ ...ON, experimentalStructuredNativeChat: false })
    ).toBe(false)
    expect(agentTabsDefaultToNativeChat({ ...ON, experimentalStructuredNativeChat: false })).toBe(
      true
    )
  })

  it.each([null, undefined, {}])('reads %s as no preference', (settings) => {
    expect(prefersStructuredNativeChatByDefault(settings)).toBe(false)
    expect(agentTabsDefaultToNativeChat(settings)).toBe(false)
  })
})

describe('per-launch structured feasibility', () => {
  it.each(['claude', 'codex'] as const)('supports a local %s launch', (agent) => {
    expect(support({ agent })).toEqual({ supported: true })
  })

  it.each([
    ['grok', { agent: 'grok' }, 'agent-without-structured-session'],
    ['openclaude', { agent: 'openclaude' }, 'agent-without-structured-session'],
    ['a draft prompt', { isDraftPrompt: true }, 'draft-prompt'],
    ['a floating workspace', { workspaceKind: 'floating' }, 'floating-workspace'],
    ['a custom TUI launch', { requiresTuiLaunchCustomization: true }, 'tui-launch-customization'],
    ['an SSH host', { executionHostId: 'ssh:host-a' }, 'remote-execution-host'],
    ['Codex on Windows', { agent: 'codex', platform: 'win32' }, 'codex-on-windows'],
    ['a missing capability', { hostCapabilities: [] }, 'runtime-capability']
  ] as [string, Partial<StructuredNativeChatSupportInput>, string][])(
    'names %s as the blocker',
    (_name, overrides, blocker) => {
      expect(support(overrides)).toEqual({ supported: false, blocker })
    }
  )

  it('leaves a Windows Claude launch to the executing host', () => {
    expect(support({ agent: 'claude', platform: 'win32' })).toEqual({ supported: true })
  })

  it('blocks a WSL or repair-required project runtime', () => {
    expect(
      support({
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
    ).toEqual({ supported: false, blocker: 'project-runtime' })
    expect(
      support({
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
    ).toEqual({ supported: false, blocker: 'project-runtime' })
  })

  it('supports a folder workspace without widening floating scope', () => {
    expect(support({ workspaceKind: 'folder' })).toEqual({ supported: true })
  })
})
