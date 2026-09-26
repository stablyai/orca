import { describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  ensureSourceControlDetectedAgents,
  resolveSourceControlAgentDetectionTarget,
  type SourceControlAgentDetectionStore
} from './source-control-agent-detection-target'

function createDetectionStore(): SourceControlAgentDetectionStore {
  return {
    ensureDetectedAgents: vi.fn(async (): Promise<TuiAgent[]> => ['claude']),
    ensureRemoteDetectedAgents: vi.fn(async (): Promise<TuiAgent[]> => ['codex']),
    ensureRuntimeDetectedAgents: vi.fn(async (): Promise<TuiAgent[]> => ['opencode'])
  }
}

describe('resolveSourceControlAgentDetectionTarget', () => {
  it('routes paired runtime workspaces with no SSH connection to the runtime host', () => {
    expect(
      resolveSourceControlAgentDetectionTarget({
        worktreeId: 'wt-1',
        connectionId: null,
        runtimeEnvironmentId: 'env-1'
      })
    ).toEqual({ kind: 'runtime', environmentId: 'env-1' })
  })

  it('does not treat a paired runtime as connection-unavailable when SSH is unhydrated', () => {
    expect(
      resolveSourceControlAgentDetectionTarget({
        worktreeId: 'wt-1',
        connectionId: undefined,
        runtimeEnvironmentId: 'env-1'
      })
    ).toEqual({ kind: 'runtime', environmentId: 'env-1' })
  })

  it('keeps unhydrated SSH worktrees unavailable instead of probing local agents', () => {
    expect(
      resolveSourceControlAgentDetectionTarget({
        worktreeId: 'wt-1',
        connectionId: undefined,
        runtimeEnvironmentId: null
      })
    ).toEqual({ kind: 'unavailable' })
  })

  it('prefers SSH detection over a runtime environment', () => {
    expect(
      resolveSourceControlAgentDetectionTarget({
        worktreeId: 'wt-1',
        connectionId: 'ssh-1',
        runtimeEnvironmentId: 'env-1'
      })
    ).toEqual({ kind: 'ssh', connectionId: 'ssh-1' })
  })

  it('routes local workspaces with no SSH or runtime host to local detection', () => {
    expect(
      resolveSourceControlAgentDetectionTarget({
        worktreeId: 'wt-1',
        connectionId: null,
        runtimeEnvironmentId: null
      })
    ).toEqual({ kind: 'local', worktreeId: 'wt-1' })
  })
})

describe('ensureSourceControlDetectedAgents', () => {
  it('probes the paired runtime host and does not fall through to local detection', async () => {
    const store = createDetectionStore()
    const target = resolveSourceControlAgentDetectionTarget({
      worktreeId: 'wt-1',
      connectionId: null,
      runtimeEnvironmentId: 'env-1'
    })

    await expect(ensureSourceControlDetectedAgents(target, store)).resolves.toEqual(['opencode'])
    expect(store.ensureRuntimeDetectedAgents).toHaveBeenCalledWith('env-1')
    expect(store.ensureDetectedAgents).not.toHaveBeenCalled()
    expect(store.ensureRemoteDetectedAgents).not.toHaveBeenCalled()
  })

  it('probes the SSH host when a connectionId is present', async () => {
    const store = createDetectionStore()
    const target = resolveSourceControlAgentDetectionTarget({
      worktreeId: 'wt-1',
      connectionId: 'ssh-1',
      runtimeEnvironmentId: null
    })

    await expect(ensureSourceControlDetectedAgents(target, store)).resolves.toEqual(['codex'])
    expect(store.ensureRemoteDetectedAgents).toHaveBeenCalledWith('ssh-1')
    expect(store.ensureDetectedAgents).not.toHaveBeenCalled()
    expect(store.ensureRuntimeDetectedAgents).not.toHaveBeenCalled()
  })

  it('probes local agents when there is no SSH connection or runtime host', async () => {
    const store = createDetectionStore()
    const target = resolveSourceControlAgentDetectionTarget({
      worktreeId: 'wt-1',
      connectionId: null,
      runtimeEnvironmentId: null
    })

    await expect(ensureSourceControlDetectedAgents(target, store)).resolves.toEqual(['claude'])
    expect(store.ensureDetectedAgents).toHaveBeenCalledWith('wt-1')
    expect(store.ensureRemoteDetectedAgents).not.toHaveBeenCalled()
    expect(store.ensureRuntimeDetectedAgents).not.toHaveBeenCalled()
  })

  it('does not probe any host while SSH ownership is unhydrated', async () => {
    const store = createDetectionStore()
    const target = resolveSourceControlAgentDetectionTarget({
      worktreeId: 'wt-1',
      connectionId: undefined,
      runtimeEnvironmentId: null
    })

    await expect(ensureSourceControlDetectedAgents(target, store)).resolves.toEqual([])
    expect(store.ensureDetectedAgents).not.toHaveBeenCalled()
    expect(store.ensureRemoteDetectedAgents).not.toHaveBeenCalled()
    expect(store.ensureRuntimeDetectedAgents).not.toHaveBeenCalled()
  })
})
