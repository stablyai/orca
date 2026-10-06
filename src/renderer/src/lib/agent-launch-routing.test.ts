import { describe, expect, it } from 'vitest'
import {
  RUNTIME_CAPABILITIES,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../shared/electron-remote-runtime-client-capabilities'
import { resolveAgentLaunchRoute, structuredAgentLaunchSupported } from './agent-launch-routing'

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

  it('routes editable drafts to the structured chat composer', () => {
    expect(route({ launchText: 'reviewable context', promptDelivery: 'draft' })).toBe(
      'structured-native-chat'
    )
  })

  // Why: the terminal mirror gate caps a draft at forty lines because a TUI cannot clear more;
  // the structured composer has no such limit and must be chosen before that gate runs.
  it('routes a draft longer than the terminal mirror cap to structured chat', () => {
    const sixtyLineDraft = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n')
    expect(route({ launchText: sixtyLineDraft, promptDelivery: 'draft' })).toBe(
      'structured-native-chat'
    )
    expect(
      route({
        launchText: sixtyLineDraft,
        promptDelivery: 'draft',
        settings: { ...settings, experimentalStructuredNativeChat: false }
      })
    ).toBe('terminal-tui')
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
    expect(route({ startsOutsideWorkspaceRoot: true })).toBe('legacy-native-chat')
  })

  it('keeps an SSH workspace terminal-backed, since no Orca runtime runs there', () => {
    expect(route({ executionHostId: 'ssh:host-a' })).toBe('legacy-native-chat')
  })

  // The lists the two sides really advertise, not hand-written ones: dropping the launch-mode
  // capability from either would quietly turn every paired-server launch into a terminal.
  it('opens a chat on a current paired server with the lists both sides advertise', () => {
    expect(
      route({
        executionHostId: 'runtime:environment-a',
        hostCapabilities: RUNTIME_CAPABILITIES,
        clientCapabilities: ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
      })
    ).toBe('structured-native-chat')
  })

  it('routes a paired server by its own capabilities', () => {
    const structured = [
      STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
      STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY
    ]
    const server = {
      executionHostId: 'runtime:environment-a',
      hostCapabilities: structured,
      clientCapabilities: structured
    }
    expect(route(server)).toBe('structured-native-chat')
    // A client that never told the server it reads structured sessions keeps the host terminal.
    expect(route({ ...server, clientCapabilities: [] })).toBe('legacy-native-chat')
    expect(route({ ...server, clientCapabilities: undefined })).toBe('legacy-native-chat')
    // A released server admits chats only with its own setting on, so it keeps the terminal.
    expect(
      route({ executionHostId: 'runtime:environment-a', clientCapabilities: structured })
    ).toBe('legacy-native-chat')
    // The server has not answered yet, or answered without structured sessions.
    expect(route({ executionHostId: 'runtime:environment-a', hostCapabilities: null })).toBe(
      'legacy-native-chat'
    )
    expect(route({ executionHostId: 'runtime:environment-a', hostCapabilities: [] })).toBe(
      'legacy-native-chat'
    )
  })

  it.each(['git-worktree', 'folder'] as const)(
    'supports a local %s without widening floating-terminal scope',
    (workspaceKind) => {
      expect(route({ workspaceKind })).toBe('structured-native-chat')
    }
  )

  // Why floating is here and not with the structured kinds: it has no workspace a session can
  // be filed under, but the chat view is a pane-level rendering the panel already hosts, so the
  // chat default still applies — terminal-backed, not structured.
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
