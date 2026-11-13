// CLOUD-HELD-SURFACE: the composer decides an Orca Cloud create's route before its VM exists. With
// chat preferred, the image's capabilities stand in for the unverified pending host, so the create
// opens a chat; without them (or with Terminal preferred) it stays a terminal, and a decided
// launch logs a chat preference it could not honour.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../../../shared/agent-session/agent-session-runtime-capabilities'
import type { AgentLaunchRouteArgs, AgentLaunchRouteStore } from './agent-launch-route-input'
import { resolveAgentSessionLaunchRoute } from './agent-session-launch-plan'
import { ORCA_CLOUD_PENDING_HOST_CAPABILITIES } from '@/lib/orca-cloud/orca-cloud-pending-host-capabilities'

vi.mock('@/runtime/hosts/preflight/local-preflight-context', () => ({
  getLocalProjectExecutionRuntimeContext: () => undefined,
  getLocalRepoProjectExecutionRuntimeContext: () => undefined
}))
vi.mock('@/app-shell/platform/web-client-location', () => ({
  isWebClientLocation: () => false
}))
vi.mock('@/runtime/hosts/capabilities/local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilitiesOrUnknown: () => [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
  awaitLocalRuntimeCapabilities: async () => undefined
}))
vi.mock('@/lib/agent-session/launch/continuation/structured-agent-launch-settlement', () => ({}))

const SETTINGS = {
  agentCmdOverrides: {},
  agentDefaultArgs: {},
  agentDefaultEnv: {}
}
const store = (surface: 'chat' | 'terminal'): AgentLaunchRouteStore =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a route store with only the settings the route reads
  ({
    settings: { ...SETTINGS, agentDefaultSurface: surface }
  }) as unknown as AgentLaunchRouteStore

const cloudCreate = (withImage: boolean): AgentLaunchRouteArgs => ({
  agent: 'claude',
  workspace: {
    kind: 'git-worktree',
    repoId: 'repo-1',
    executionHostId: 'runtime:pending-ephemeral-vm'
  },
  ...(withImage ? { pendingHostCapabilities: ORCA_CLOUD_PENDING_HOST_CAPABILITIES } : {})
})

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  warn.mockRestore()
})

describe('an Orca Cloud create decided before its VM exists (CLOUD-HELD-SURFACE)', () => {
  it('chat preferred: the image capabilities make it a chat, with nothing logged', () => {
    expect(
      resolveAgentSessionLaunchRoute(store('chat'), cloudCreate(true), {
        reportDowngrade: true
      })
    ).toBe('structured-native-chat')
    expect(warn).not.toHaveBeenCalled()
  })

  it('without them it stays a terminal, and a decided launch logs why', () => {
    expect(
      resolveAgentSessionLaunchRoute(store('chat'), cloudCreate(false), {
        reportDowngrade: true
      })
    ).toBe('terminal-tui')
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        '[agent-launch-route] claude opens terminal-tui: runtime-capability-unknown'
      )
    )
  })

  it('a render-time preview never logs', () => {
    expect(resolveAgentSessionLaunchRoute(store('chat'), cloudCreate(false))).toBe('terminal-tui')
    expect(warn).not.toHaveBeenCalled()
  })

  it('terminal preferred: a terminal, image or not, with nothing logged', () => {
    for (const withImage of [true, false]) {
      expect(
        resolveAgentSessionLaunchRoute(store('terminal'), cloudCreate(withImage), {
          reportDowngrade: true
        })
      ).toBe('terminal-tui')
    }
    expect(warn).not.toHaveBeenCalled()
  })

  it('a host whose capabilities are verified is decided by those, never the image list', () => {
    const verified = (capabilities: readonly string[]) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: settings plus the one runtime status the route reads
      ({
        settings: { ...SETTINGS, agentDefaultSurface: 'chat' },
        runtimeStatusByEnvironmentId: new Map([['env-old', { status: { capabilities } }]])
      }) as unknown as AgentLaunchRouteStore
    const onOldImage = {
      agent: 'claude',
      workspace: {
        kind: 'git-worktree',
        repoId: 'repo-1',
        executionHostId: 'runtime:env-old'
      },
      pendingHostCapabilities: ORCA_CLOUD_PENDING_HOST_CAPABILITIES
    } as const
    expect(resolveAgentSessionLaunchRoute(verified([]), onOldImage)).toBe('terminal-tui')
    expect(
      resolveAgentSessionLaunchRoute(verified(ORCA_CLOUD_PENDING_HOST_CAPABILITIES), onOldImage)
    ).toBe('structured-native-chat')
  })

  it('a local create is unaffected', () => {
    expect(
      resolveAgentSessionLaunchRoute(store('chat'), {
        agent: 'claude',
        workspace: {
          kind: 'git-worktree',
          repoId: 'repo-1',
          executionHostId: 'local'
        }
      })
    ).toBe('structured-native-chat')
  })
})
