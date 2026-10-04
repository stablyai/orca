/**
 * The shared half of the launch route: the renderer's `resolveAgentLaunchRoute` and orchestration's
 * worker-mode decision both answer from these, so a change here moves both surfaces at once.
 */

import { describe, expect, it } from 'vitest'
import {
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  CURSOR_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from './protocol-version'
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

describe('Cursor native Chat launch', () => {
  it('uses the native Chat preference independently of the separate structured experiment', () => {
    expect(
      prefersStructuredNativeChatByDefault(
        { ...ON, experimentalStructuredNativeChat: false },
        'cursor'
      )
    ).toBe(true)
    expect(
      prefersStructuredNativeChatByDefault({ ...ON, openAgentTabsInChatByDefault: false }, 'cursor')
    ).toBe(false)
    expect(
      prefersStructuredNativeChatByDefault({ ...ON, experimentalNativeChat: false }, 'cursor')
    ).toBe(false)
  })
  it('requires both negotiated capabilities and retains Terminal fallbacks', () => {
    const hostCapabilities = [
      STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
      CURSOR_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
    ]
    expect(support({ agent: 'cursor' })).toEqual({
      supported: false,
      blocker: 'runtime-capability'
    })
    expect(support({ agent: 'cursor', hostCapabilities, workspaceKind: 'folder' })).toEqual({
      supported: true
    })
    expect(support({ agent: 'cursor', hostCapabilities, executionHostId: 'ssh:host' })).toEqual({
      supported: false,
      blocker: 'remote-execution-host'
    })
    expect(support({ agent: 'cursor', hostCapabilities, reusesTerminal: true })).toEqual({
      supported: false,
      blocker: 'reused-terminal'
    })
    expect(support({ agent: 'cursor', hostCapabilities, requiresTuiLaunchCommand: true })).toEqual({
      supported: false,
      blocker: 'tui-launch-command'
    })
  })
})

describe('Cursor and paired-host launch capability composition', () => {
  const hostCapabilities = [
    STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
    CURSOR_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
    STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY
  ]
  const clientCapabilities = [
    CURSOR_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
    STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
    STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY
  ]
  const pairedCursor = {
    agent: 'cursor',
    executionHostId: 'runtime:host',
    hostCapabilities,
    clientCapabilities
  } as const

  it.each(['git-worktree', 'folder'] as const)(
    'supports Cursor on a capable paired %s workspace',
    (workspaceKind) => {
      expect(support({ ...pairedCursor, workspaceKind })).toEqual({ supported: true })
    }
  )

  it.each(hostCapabilities)('refuses a paired Cursor host without %s', (missingCapability) => {
    expect(
      support({
        ...pairedCursor,
        hostCapabilities: hostCapabilities.filter((value) => value !== missingCapability)
      })
    ).toEqual({ supported: false, blocker: 'runtime-capability' })
  })

  it.each(clientCapabilities)('refuses a paired Cursor client without %s', (missingCapability) => {
    expect(
      support({
        ...pairedCursor,
        clientCapabilities: clientCapabilities.filter((value) => value !== missingCapability)
      })
    ).toEqual({ supported: false, blocker: 'client-capability' })
  })

  it('keeps an unanswered paired Cursor host distinct from a capability refusal', () => {
    expect(support({ ...pairedCursor, hostCapabilities: null })).toEqual({
      supported: false,
      blocker: 'runtime-capability-unknown'
    })
  })
})

it.each(['claude', 'codex'] as const)(
  'keeps paired %s launch support without Cursor capability',
  (agent) => {
    const capabilities = [
      STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
      STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY
    ]
    expect(
      support({
        agent,
        executionHostId: 'runtime:host',
        hostCapabilities: capabilities,
        clientCapabilities: capabilities,
        workspaceKind: 'folder'
      })
    ).toEqual({ supported: true })
  }
)
