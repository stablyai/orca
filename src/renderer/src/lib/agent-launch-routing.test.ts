import { describe, expect, it } from 'vitest'
import {
  RUNTIME_CAPABILITIES,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../shared/electron-remote-runtime-client-capabilities'
import { resolveAgentLaunchRoute, structuredAgentLaunchSupported } from './agent-launch-routing'

const settings = { experimentalNativeChat: true }

function route(overrides: Partial<Parameters<typeof resolveAgentLaunchRoute>[0]> = {}) {
  return resolveAgentLaunchRoute({
    agent: 'codex',
    settings,
    executionHostId: 'local',
    hostCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
    workspaceKind: 'git-worktree',
    ...overrides
  })
}

describe('new agent launch routing', () => {
  it.each(['claude', 'codex'] as const)('opens supported local %s in structured chat', (agent) => {
    expect(route({ agent })).toBe('structured-native-chat')
    expect(route({ agent, launchText: 'draft', promptDelivery: 'draft' })).toBe(
      'structured-native-chat'
    )
  })

  it('uses Chat UI alone even when an old selector is false or absent', () => {
    const oldSelectorOff = { experimentalNativeChat: true, openAgentTabsInChatByDefault: false }
    expect(route({ settings: oldSelectorOff })).toBe('structured-native-chat')
    expect(route({ settings: { experimentalNativeChat: true } })).toBe('structured-native-chat')
  })

  // Why: a TUI caps a mirrored draft at forty lines; the structured composer has no such limit.
  it('routes a draft longer than the terminal mirror cap to structured chat', () => {
    const sixtyLineDraft = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n')
    expect(route({ launchText: sixtyLineDraft, promptDelivery: 'draft' })).toBe(
      'structured-native-chat'
    )
  })

  it('opens the terminal when Chat UI is off', () => {
    expect(route({ settings: { experimentalNativeChat: false } })).toBe('terminal-tui')
    expect(route({ settings: null })).toBe('terminal-tui')
  })

  it('keeps unsupported and unverified launches in terminal UI', () => {
    expect(route({ hostCapabilities: [] })).toBe('terminal-tui')
    expect(route({ hostCapabilities: null })).toBe('terminal-tui')
    expect(route({ agent: 'openclaude' })).toBe('terminal-tui')
    // Grok has no built-in structured adapter; only a host agent list admits it.
    expect(route({ agent: 'grok' })).toBe('terminal-tui')
    expect(route({ startsOutsideWorkspaceRoot: true })).toBe('terminal-tui')
    expect(route({ executionHostId: 'ssh:host-a' })).toBe('terminal-tui')
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
    ).toBe('terminal-tui')
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
    ).toBe('terminal-tui')
  })

  it('uses the host agent list for providers beyond Claude and Codex', () => {
    expect(
      route({
        agent: 'grok',
        hostCapabilities: [
          STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
          STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
        ],
        hostStructuredAgents: ['grok']
      })
    ).toBe('structured-native-chat')
  })

  it.each(['git-worktree', 'folder', 'floating'] as const)(
    'allows a supported local %s workspace',
    (workspaceKind) => expect(route({ workspaceKind })).toBe('structured-native-chat')
  )

  it('honors current paired-host capabilities and falls back on older hosts', () => {
    expect(
      route({
        executionHostId: 'runtime:environment-a',
        hostCapabilities: RUNTIME_CAPABILITIES,
        clientCapabilities: ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
      })
    ).toBe('structured-native-chat')
    const negotiated = [
      STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
      STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY
    ]
    expect(
      route({
        executionHostId: 'runtime:environment-a',
        hostCapabilities: negotiated,
        clientCapabilities: negotiated
      })
    ).toBe('structured-native-chat')
    expect(
      route({
        executionHostId: 'runtime:environment-a',
        hostCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
        clientCapabilities: negotiated
      })
    ).toBe('terminal-tui')
    const server = {
      executionHostId: 'runtime:environment-a',
      hostCapabilities: negotiated,
      clientCapabilities: negotiated
    }
    // A client that never told the server it reads structured sessions keeps the host terminal.
    expect(route({ ...server, clientCapabilities: [] })).toBe('terminal-tui')
    expect(route({ ...server, clientCapabilities: undefined })).toBe('terminal-tui')
    // The server has not answered yet, or answered without structured sessions.
    expect(route({ ...server, hostCapabilities: null })).toBe('terminal-tui')
    expect(route({ ...server, hostCapabilities: [] })).toBe('terminal-tui')
  })
})

describe('explicit structured chat requests', () => {
  it.each(['claude', 'codex'] as const)('supports %s history resume on a capable host', (agent) => {
    const input = {
      agent,
      settings,
      executionHostId: 'local',
      hostCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
      workspaceKind: 'folder' as const
    }
    expect(structuredAgentLaunchSupported(input)).toBe(true)
    expect(structuredAgentLaunchSupported({ ...input, hostCapabilities: [] })).toBe(false)
  })

  it('still permits an explicit structured history request while Chat UI is off', () => {
    const input = {
      agent: 'codex' as const,
      settings: { experimentalNativeChat: false },
      executionHostId: 'local',
      hostCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
    }
    expect(resolveAgentLaunchRoute(input)).toBe('terminal-tui')
    expect(structuredAgentLaunchSupported(input)).toBe(true)
    expect(structuredAgentLaunchSupported({ ...input, settings: null })).toBe(true)
  })
})
