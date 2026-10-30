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
  it('opens the terminal when Chat UI is off', () => {
    expect(route({ settings: { experimentalNativeChat: false } })).toBe('terminal-tui')
    expect(route({ settings: null })).toBe('terminal-tui')
  })

  it("follows each agent's chat provider switch", () => {
    const grokHost = {
      agent: 'grok' as const,
      hostCapabilities: [
        STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
        STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
      ],
      hostStructuredAgents: ['grok']
    }
    expect(route({ agent: 'claude' })).toBe('structured-native-chat')
    expect(route(grokHost)).toBe('structured-native-chat')
    expect(
      route({ ...grokHost, settings: { ...settings, nativeChatProviders: { grok: false } } })
    ).toBe('terminal-tui')
    expect(route({ settings: { ...settings, nativeChatProviders: { codex: false } } })).toBe(
      'terminal-tui'
    )
    expect(
      route({
        ...grokHost,
        settings: { ...settings, nativeChatProviders: { grok: true } }
      })
    ).toBe('structured-native-chat')
  })

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
    expect(route({ ...server, hostCapabilities: null })).toBe('terminal-tui')
    expect(route({ ...server, hostCapabilities: [] })).toBe('terminal-tui')
  })
})

describe('explicit structured chat requests', () => {
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
