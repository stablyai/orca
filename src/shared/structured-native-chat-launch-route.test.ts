/**
 * The shared half of the launch route: the renderer's `resolveAgentLaunchRoute` and orchestration's
 * worker-mode decision both answer from these, so a change here moves both surfaces at once.
 */

import { describe, expect, it } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from './protocol-version'
import {
  agentTabsDefaultToNativeChat,
  isNativeChatEnabled,
  resolveStructuredNativeChatSupport,
  type StructuredNativeChatSupportInput
} from './structured-native-chat-launch-route'

const ON = {
  experimentalNativeChat: true,
  openAgentTabsInChatByDefault: true
}

function support(overrides: Partial<StructuredNativeChatSupportInput> = {}) {
  return resolveStructuredNativeChatSupport({
    agent: 'claude',
    executionHostId: 'local',
    hostCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
    workspaceKind: 'git-worktree',
    ...overrides
  })
}

describe('the settings default', () => {
  it('defaults new tabs to native chat only with Chat UI on and the Chat UI default view', () => {
    expect(agentTabsDefaultToNativeChat(ON)).toBe(true)
    expect(agentTabsDefaultToNativeChat({ ...ON, experimentalNativeChat: false })).toBe(false)
    expect(agentTabsDefaultToNativeChat({ ...ON, openAgentTabsInChatByDefault: false })).toBe(false)
  })

  it('enables Chat UI from its own toggle, whatever the default view', () => {
    const terminalDefaultView = { ...ON, openAgentTabsInChatByDefault: false }
    expect(isNativeChatEnabled(ON)).toBe(true)
    expect(isNativeChatEnabled(terminalDefaultView)).toBe(true)
    expect(isNativeChatEnabled({ ...ON, experimentalNativeChat: false })).toBe(false)
  })

  it.each([null, undefined, {}])('reads %s as no preference', (settings) => {
    expect(isNativeChatEnabled(settings)).toBe(false)
    expect(agentTabsDefaultToNativeChat(settings)).toBe(false)
  })
})

describe('per-launch structured feasibility', () => {
  it.each(['claude', 'codex'] as const)('supports a local %s launch', (agent) => {
    expect(support({ agent })).toEqual({ supported: true })
  })

  const blockerCases: [string, Partial<StructuredNativeChatSupportInput>, string][] = [
    ['a reused PTY agent', { reusesTerminal: true }, 'reused-terminal'],
    ['grok', { agent: 'grok' }, 'agent-without-structured-session'],
    ['openclaude', { agent: 'openclaude' }, 'agent-without-structured-session'],
    ['a floating workspace', { workspaceKind: 'floating' }, 'floating-workspace'],
    ['a custom TUI launch command', { requiresTuiLaunchCommand: true }, 'tui-launch-command'],
    ['an SSH host', { executionHostId: 'ssh:host-a' }, 'remote-execution-host'],
    ['a missing capability', { hostCapabilities: [] }, 'runtime-capability'],
    ['an unanswered host', { hostCapabilities: null }, 'runtime-capability-unknown']
  ]

  it.each(blockerCases)('names %s as the blocker', (_name, overrides, blocker) => {
    expect(support(overrides)).toEqual({ supported: false, blocker })
  })

  // The client cannot see whether the host can read a provider child's start time, so neither
  // provider is refused here on platform; agentSession.createSupport answers that at create time.
  it.each(['claude', 'codex'] as const)(
    'leaves a Windows %s launch to the executing host',
    (agent) => {
      expect(support({ agent })).toEqual({ supported: true })
    }
  )

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
