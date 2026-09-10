import { describe, expect, it } from 'vitest'
import {
  matchesMaestroTerminalLaunchProfile,
  matchesMaestroTerminalLeaseTransferIdentity
} from './maestro-terminal-lease-transfer'

describe('Maestro terminal lease transfer contract', () => {
  const identity = {
    kind: 'strict_retry' as const,
    runId: 'run_1',
    taskId: 'task_1',
    attemptId: 'attempt_1',
    terminalHandle: 'term_1',
    ptyIncarnation: 'pty_1',
    processRootId: 'pid_1',
    executionHostId: 'host_1',
    workspaceKey: 'worktree:one',
    hostScope: 'host_1',
    predecessorOwnerPrincipal: 'dispatch:old',
    successorOwnerPrincipal: 'dispatch:new',
    coordinatorGeneration: 3,
    launchProfile: {
      agent: 'codex' as const,
      model: 'gpt-5.6-terra',
      effort: 'high',
      permissionMode: 'yolo',
      routeRef: 'route_1',
      serviceTier: 'default' as const,
      environmentPolicy: 'sha256:environment'
    },
    retentionPolicy: 'auto_release' as const
  }

  it('rejects a replay whose authority or placement identity changes', () => {
    expect(matchesMaestroTerminalLeaseTransferIdentity(identity, { ...identity })).toBe(true)
    expect(
      matchesMaestroTerminalLeaseTransferIdentity(identity, {
        ...identity,
        workspaceKey: 'worktree:two'
      })
    ).toBe(false)
    expect(
      matchesMaestroTerminalLeaseTransferIdentity(identity, {
        ...identity,
        successorOwnerPrincipal: 'dispatch:other'
      })
    ).toBe(false)
  })

  it('matches launch profile identity independently of property insertion order', () => {
    const reordered = {
      permissionMode: identity.launchProfile.permissionMode,
      routeRef: identity.launchProfile.routeRef,
      effort: identity.launchProfile.effort,
      model: identity.launchProfile.model,
      agent: identity.launchProfile.agent,
      serviceTier: identity.launchProfile.serviceTier,
      environmentPolicy: identity.launchProfile.environmentPolicy
    }

    expect(matchesMaestroTerminalLaunchProfile(identity.launchProfile, reordered)).toBe(true)
    expect(
      matchesMaestroTerminalLaunchProfile(identity.launchProfile, {
        ...reordered,
        permissionMode: 'default'
      })
    ).toBe(false)
    expect(
      matchesMaestroTerminalLaunchProfile(identity.launchProfile, {
        ...reordered,
        serviceTier: 'fast'
      })
    ).toBe(false)
  })
  it('matches omitted optional legacy profile fields without accepting a changed policy', () => {
    const legacy = {
      ...identity.launchProfile,
      serviceTier: undefined,
      environmentPolicy: undefined
    }
    expect(
      matchesMaestroTerminalLaunchProfile(legacy, {
        ...legacy,
        serviceTier: null,
        environmentPolicy: null
      })
    ).toBe(true)
    expect(matchesMaestroTerminalLaunchProfile(legacy, identity.launchProfile)).toBe(false)
  })
})
