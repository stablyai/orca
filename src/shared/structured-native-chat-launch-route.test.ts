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
  structuredNativeChatRemoteCreateEnabled,
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

  it.each([
    ['a reused PTY agent', { reusesTerminal: true }, 'reused-terminal'],
    ['grok', { agent: 'grok' }, 'agent-without-structured-session'],
    ['openclaude', { agent: 'openclaude' }, 'agent-without-structured-session'],
    ['a floating workspace', { workspaceKind: 'floating' }, 'floating-workspace'],
    ['a custom TUI launch', { requiresTuiLaunchCustomization: true }, 'tui-launch-customization'],
    ['an SSH host', { executionHostId: 'ssh:host-a' }, 'remote-execution-host'],
    ['a missing capability', { hostCapabilities: [] }, 'runtime-capability'],
    ['an unanswered host', { hostCapabilities: null }, 'runtime-capability-unknown']
  ] as [string, Partial<StructuredNativeChatSupportInput>, string][])(
    'names %s as the blocker',
    (_name, overrides, blocker) => {
      expect(support(overrides)).toEqual({ supported: false, blocker })
    }
  )

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

describe('creating on a paired host', () => {
  const PAIRED = { executionHostId: 'runtime:env-1' } as const

  it('is off for a user who has never been asked', () => {
    // Not `!== false`: absent settings are a user who never saw the switch, and this is the state
    // the merge commit ships in. A default of on here would start sessions on other people's
    // machines for every user who upgrades.
    expect(structuredNativeChatRemoteCreateEnabled(undefined)).toBe(false)
    expect(structuredNativeChatRemoteCreateEnabled(null)).toBe(false)
    expect(structuredNativeChatRemoteCreateEnabled({})).toBe(false)
    expect(structuredNativeChatRemoteCreateEnabled({ ...ON })).toBe(false)
    expect(structuredNativeChatRemoteCreateEnabled({ structuredChatRemoteCreate: false })).toBe(
      false
    )
    expect(structuredNativeChatRemoteCreateEnabled({ structuredChatRemoteCreate: true })).toBe(true)
  })

  it('names the switch, not the host, while the switch is off', () => {
    expect(support(PAIRED)).toEqual({ supported: false, blocker: 'remote-create-disabled' })
    expect(support({ ...PAIRED, remoteCreateEnabled: false })).toEqual({
      supported: false,
      blocker: 'remote-create-disabled'
    })
  })

  it('is supported once the switch is on and the host advertises it', () => {
    expect(support({ ...PAIRED, remoteCreateEnabled: true })).toEqual({ supported: true })
  })

  it('still lets the host answer for itself once the switch is on', () => {
    expect(
      support({ ...PAIRED, remoteCreateEnabled: true, hostStatusBlocker: 'host-policy-disabled' })
    ).toEqual({ supported: false, blocker: 'host-policy-disabled' })
    expect(
      support({ ...PAIRED, remoteCreateEnabled: true, hostStatusBlocker: 'host-disconnected' })
    ).toEqual({ supported: false, blocker: 'host-disconnected' })
    expect(support({ ...PAIRED, remoteCreateEnabled: true, hostCapabilities: [] })).toEqual({
      supported: false,
      blocker: 'runtime-capability'
    })
    expect(support({ ...PAIRED, remoteCreateEnabled: true, hostCapabilities: null })).toEqual({
      supported: false,
      blocker: 'runtime-capability-unknown'
    })
  })

  // `runtimeTargetForExecutionHostId` has no environment target for `ssh:`, so there is no client
  // RPC path to create one there however this client is configured.
  it.each(['ssh:host-a', 'ssh:runtime-ssh-env-1', 'nonsense'])(
    'refuses %s whatever the switch says',
    (executionHostId) => {
      for (const remoteCreateEnabled of [false, true]) {
        expect(support({ executionHostId, remoteCreateEnabled })).toEqual({
          supported: false,
          blocker: 'remote-execution-host'
        })
      }
    }
  )
})
