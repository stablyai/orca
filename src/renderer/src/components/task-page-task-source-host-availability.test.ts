import { describe, expect, it } from 'vitest'
import { TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { ExecutionHostRegistryEntry } from '../../../shared/execution-host-registry'
import {
  getGitHubProjectSourceSummary,
  getTaskSourceHostAvailabilityForHost
} from './task-page-source-context'

// Why: a complete typed entry keeps these cases honest when the registry shape changes.
function hostEntry(
  overrides: Partial<ExecutionHostRegistryEntry> = {}
): ExecutionHostRegistryEntry {
  return {
    id: 'local',
    kind: 'local',
    label: 'This Mac',
    detail: 'local',
    health: 'local',
    ...overrides
  }
}

describe('getTaskSourceHostAvailabilityForHost', () => {
  it('returns null when there is no host', () => {
    expect(getTaskSourceHostAvailabilityForHost(null, 'local')).toBeNull()
  })

  it('reports a runtime still checking capabilities', () => {
    const host = hostEntry({
      id: 'runtime:env-1',
      kind: 'runtime',
      label: 'Env',
      health: 'available'
    })
    expect(getTaskSourceHostAvailabilityForHost(host, 'runtime:env-1')).toEqual({
      hostId: 'runtime:env-1',
      reason: 'checking-task-source-capability'
    })
  })

  it('reports a runtime missing the task-source capability', () => {
    const host = hostEntry({
      id: 'runtime:env-1',
      kind: 'runtime',
      label: 'Env',
      health: 'available',
      capabilities: []
    })
    expect(getTaskSourceHostAvailabilityForHost(host, 'runtime:env-1')).toEqual({
      hostId: 'runtime:env-1',
      reason: 'missing-task-source-capability'
    })
  })

  it('returns null for a healthy runtime that declares the capability', () => {
    const host = hostEntry({
      id: 'runtime:env-1',
      kind: 'runtime',
      label: 'Env',
      health: 'available',
      capabilities: [TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY]
    })
    expect(getTaskSourceHostAvailabilityForHost(host, 'runtime:env-1')).toBeNull()
  })

  it('returns null for a healthy local host', () => {
    expect(getTaskSourceHostAvailabilityForHost(hostEntry(), 'local')).toBeNull()
  })

  it('passes through unhealthy host status', () => {
    const host = hostEntry({
      id: 'ssh:box',
      kind: 'ssh',
      label: 'Box',
      health: 'disconnected',
      connectionStatus: 'disconnected',
      capabilities: [TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY]
    })
    expect(getTaskSourceHostAvailabilityForHost(host, 'ssh:box')).toEqual({
      hostId: 'ssh:box',
      health: 'disconnected',
      status: 'disconnected'
    })
  })
})

describe('getGitHubProjectSourceSummary', () => {
  const runtimeHost = (overrides: Partial<ExecutionHostRegistryEntry>) =>
    hostEntry({ id: 'runtime:env-1', kind: 'runtime', label: 'Build server', ...overrides })

  it('names the board host, which a capability check alone never marks unavailable', () => {
    const summary = getGitHubProjectSourceSummary({
      providerLabel: 'GitHub',
      hostId: 'runtime:env-1',
      host: runtimeHost({ health: 'available' }),
      hostLabelById: new Map([['runtime:env-1', 'Build server']])
    })
    expect(summary.label).toBe('GitHub · Build server · Current account')
  })

  it('says when the board host is unreachable', () => {
    const summary = getGitHubProjectSourceSummary({
      providerLabel: 'GitHub',
      hostId: 'runtime:env-1',
      host: runtimeHost({
        health: 'disconnected',
        capabilities: [TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY]
      }),
      hostLabelById: new Map([['runtime:env-1', 'Build server']])
    })
    expect(summary.label).toContain('Build server · ')
    expect(summary.label).not.toBe('GitHub · Build server · Current account')
  })
})
