import { EVERY_AGENT_CHAT } from '../../../shared/native-chat/every-agent-chat.test-fixture'
import { describe, expect, it } from 'vitest'
import { RUNTIME_CAPABILITIES } from '../../../shared/protocol-version'
import {
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../shared/agent-session/agent-session-runtime-capabilities'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../shared/electron-remote-runtime-client-capabilities'
import { resolveAgentLaunchRoute, structuredAgentLaunchSupported } from './agent-launch-routing'

const settings = { nativeChatProviders: EVERY_AGENT_CHAT }

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
      settings: { nativeChatProviders: {} },
      executionHostId: 'local',
      hostCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
    }
    expect(resolveAgentLaunchRoute(input)).toBe('terminal-tui')
    expect(structuredAgentLaunchSupported(input)).toBe(true)
    expect(structuredAgentLaunchSupported({ ...input, settings: null })).toBe(true)
  })
})
