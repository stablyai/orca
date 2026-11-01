/** Renderer and orchestration share launch feasibility/defaults; changes here must move both surfaces together. */

import { describe, expect, it } from 'vitest'
import {
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from './protocol-version'
import {
  nativeChatPreferenceFor,
  resolveStructuredNativeChatSupport,
  type NativeChatDefaultSettings,
  type StructuredNativeChatSupportInput
} from './structured-native-chat-launch-route'

function support(overrides: Partial<StructuredNativeChatSupportInput> = {}) {
  return resolveStructuredNativeChatSupport({
    agent: 'claude',
    executionHostId: 'local',
    hostCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
    workspaceKind: 'git-worktree',
    ...overrides
  })
}

describe('per-launch structured feasibility', () => {
  const blockerCases: [string, Partial<StructuredNativeChatSupportInput>, string][] = [
    ['a reused PTY agent', { reusesTerminal: true }, 'reused-terminal'],
    ['grok', { agent: 'grok' }, 'agent-without-structured-session'],
    ['openclaude', { agent: 'openclaude' }, 'agent-without-structured-session'],
    ['a custom start directory', { startsOutsideWorkspaceRoot: true }, 'custom-start-directory'],
    ['a host-nested SSH project', { projectExecutionKind: 'ssh' }, 'remote-execution-host'],
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

  // Floating workspaces have resolvable configured directories; kind alone must not refuse structured launches.
  it.each(['folder', 'floating', 'git-worktree'] as const)(
    'supports a local %s workspace',
    (workspaceKind) => {
      expect(support({ workspaceKind })).toEqual({ supported: true })
    }
  )
})

describe('agents beyond Claude and Codex', () => {
  const REGISTERED = [
    STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
    STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
  ]

  it.each(['grok', 'pi'] as const)(
    '%s is offered only by a host that advertises and lists it',
    (agent) => {
      expect(
        support({ agent, hostCapabilities: REGISTERED, hostStructuredAgents: [agent] })
      ).toEqual({ supported: true })
    }
  )

  it('are not offered by a host that does not advertise its registered agents', () => {
    expect(support({ agent: 'grok', hostStructuredAgents: ['grok'] })).toEqual({
      supported: false,
      blocker: 'runtime-capability'
    })
  })

  it('are not offered when the host did not list them', () => {
    expect(support({ agent: 'grok', hostCapabilities: REGISTERED })).toEqual({
      supported: false,
      blocker: 'agent-without-structured-session'
    })
    expect(
      support({ agent: 'grok', hostCapabilities: REGISTERED, hostStructuredAgents: ['claude'] })
    ).toEqual({ supported: false, blocker: 'agent-without-structured-session' })
  })

  it('leave Claude and Codex offered by hosts that predate the capability', () => {
    expect(support({ agent: 'claude' })).toEqual({ supported: true })
    expect(support({ agent: 'codex' })).toEqual({ supported: true })
  })
})

describe('per-agent Chat | CLI preference', () => {
  it('opens only an agent saved as chat as a chat, host-registered ids included', () => {
    expect(
      nativeChatPreferenceFor({ nativeChatProviders: { 'acme-agent': true } }, 'acme-agent')
    ).toBe(true)
    expect(nativeChatPreferenceFor({}, 'claude')).toBe(false)
    expect(nativeChatPreferenceFor({ nativeChatProviders: { claude: true } }, 'acme-agent')).toBe(
      false
    )
    expect(nativeChatPreferenceFor({ nativeChatProviders: { claude: false } }, 'claude')).toBe(
      false
    )
    expect(nativeChatPreferenceFor(null, 'claude')).toBe(false)
    // Inherited object keys are not saved choices.
    expect(nativeChatPreferenceFor({ nativeChatProviders: {} }, 'constructor')).toBe(false)
  })
})

it.each(['chat', 'terminal'] as const)(
  'resolves boolean overrides before default %s for existing and later agents',
  (agentDefaultSurface) => {
    const settings: NativeChatDefaultSettings = {
      agentDefaultSurface,
      nativeChatProviders: { claude: false, codex: true }
    }
    expect(nativeChatPreferenceFor(settings, 'claude')).toBe(false)
    expect(nativeChatPreferenceFor(settings, 'codex')).toBe(true)
    expect(nativeChatPreferenceFor(settings, 'later-agent')).toBe(agentDefaultSurface === 'chat')
    Reflect.set(settings.nativeChatProviders!, 'malformed', 'true')
    expect(nativeChatPreferenceFor(settings, 'malformed')).toBe(agentDefaultSurface === 'chat')
    Reflect.set(settings, 'agentDefaultSurface', 'invalid')
    expect(nativeChatPreferenceFor(settings, 'later-agent')).toBe(false)
  }
)
