import { describe, expect, it } from 'vitest'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { createTestStore } from './store-test-helpers'
import {
  selectRuntimeAwareSshStatus,
  selectRuntimeAwareSshTargetLabel,
  selectRuntimeAwareSshTargetRemoved
} from './runtime-environment-ssh'

const ENV_A = 'env-a'
const ENV_B = 'env-b'

function connState(
  targetId: string,
  status: SshConnectionState['status'] = 'connected'
): SshConnectionState {
  return { targetId, status, error: null, reconnectAttempt: 0 }
}

function markReachable(store: ReturnType<typeof createTestStore>, environmentId: string): void {
  store.getState().setRuntimeEnvironmentStatus(environmentId, {
    status: { runtimeId: environmentId } as RuntimeStatus,
    checkedAt: Date.now()
  })
}

describe('runtime-environment-ssh slice', () => {
  it('routes state into the owning environment bucket without touching local maps or other buckets', () => {
    const store = createTestStore()
    store.getState().setEnvironmentSshTargetsMetadata(ENV_B, [{ id: 'ssh-b', label: 'b-box' }])
    const localStatesBefore = store.getState().sshConnectionStates
    const localLabelsBefore = store.getState().sshTargetLabels
    const bucketBBefore = store.getState().sshStateByEnvironment.get(ENV_B)

    store.getState().setEnvironmentSshConnectionState(ENV_A, 'ssh-a', connState('ssh-a'))
    store.getState().setEnvironmentSshTargetsMetadata(ENV_A, [{ id: 'ssh-a', label: 'a-box' }])
    store.getState().setEnvironmentRemovedSshTargetLabels(ENV_A, { 'ssh-dead': 'old box' })

    const state = store.getState()
    // Local maps: bit-identical (same references, still empty).
    expect(state.sshConnectionStates).toBe(localStatesBefore)
    expect(state.sshTargetLabels).toBe(localLabelsBefore)
    expect(state.sshConnectionStates.size).toBe(0)
    expect(state.sshTargetsHydrated).toBe(false)
    // Environment B's bucket: untouched reference.
    expect(state.sshStateByEnvironment.get(ENV_B)).toBe(bucketBBefore)
    // Environment A's bucket: populated.
    const bucketA = state.sshStateByEnvironment.get(ENV_A)
    expect(bucketA?.connectionStates.get('ssh-a')?.status).toBe('connected')
    expect(bucketA?.targetLabels.get('ssh-a')).toBe('a-box')
    expect(bucketA?.removedTargetLabels.get('ssh-dead')).toBe('old box')
    expect(bucketA?.targetsHydrated).toBe(true)
  })

  it('local slice writes never leak into environment buckets', () => {
    const store = createTestStore()
    store.getState().setEnvironmentSshTargetsMetadata(ENV_A, [{ id: 'ssh-a', label: 'a-box' }])
    const bucketBefore = store.getState().sshStateByEnvironment.get(ENV_A)

    store.getState().setSshConnectionState('ssh-a', connState('ssh-a', 'disconnected'))
    store.getState().setSshTargetsMetadata([{ id: 'ssh-a', label: 'local a' } as never])

    expect(store.getState().sshStateByEnvironment.get(ENV_A)).toBe(bucketBefore)
    expect(store.getState().sshStateByEnvironment.get(ENV_A)?.connectionStates.size).toBe(0)
  })

  it('keeps references stable when applying an identical state or target list', () => {
    const store = createTestStore()
    store.getState().setEnvironmentSshConnectionState(ENV_A, 'ssh-a', connState('ssh-a'))
    store.getState().setEnvironmentSshTargetsMetadata(ENV_A, [{ id: 'ssh-a', label: 'a-box' }])
    const mapBefore = store.getState().sshStateByEnvironment
    const bucketBefore = mapBefore.get(ENV_A)

    store.getState().setEnvironmentSshConnectionState(ENV_A, 'ssh-a', connState('ssh-a'))
    store.getState().setEnvironmentSshTargetsMetadata(ENV_A, [{ id: 'ssh-a', label: 'a-box' }])
    store.getState().setEnvironmentRemovedSshTargetLabels(ENV_A, {})

    expect(store.getState().sshStateByEnvironment).toBe(mapBefore)
    expect(store.getState().sshStateByEnvironment.get(ENV_A)).toBe(bucketBefore)
  })

  it('publishes an authoritative connection generation change in the owning bucket', () => {
    const store = createTestStore()
    store.getState().setEnvironmentSshConnectionState(ENV_A, 'ssh-a', {
      ...connState('ssh-a'),
      connectionGeneration: 1
    })
    const bucketBefore = store.getState().sshStateByEnvironment.get(ENV_A)

    store.getState().setEnvironmentSshConnectionState(ENV_A, 'ssh-a', {
      ...connState('ssh-a'),
      connectionGeneration: 2
    })

    const bucketAfter = store.getState().sshStateByEnvironment.get(ENV_A)
    expect(bucketAfter).not.toBe(bucketBefore)
    expect(bucketAfter?.connectionStates.get('ssh-a')?.connectionGeneration).toBe(2)
  })

  it('flips the hydrated flag on the first fetch of an empty target list', () => {
    const store = createTestStore()
    store.getState().setEnvironmentSshTargetsMetadata(ENV_A, [])
    expect(store.getState().sshStateByEnvironment.get(ENV_A)?.targetsHydrated).toBe(true)
  })

  it('drops only the detached environment bucket on retain', () => {
    const store = createTestStore()
    store.getState().setEnvironmentSshTargetsMetadata(ENV_A, [{ id: 'ssh-a', label: 'a-box' }])
    store.getState().setEnvironmentSshTargetsMetadata(ENV_B, [{ id: 'ssh-b', label: 'b-box' }])
    store.getState().setSshTargetsMetadata([{ id: 'ssh-local', label: 'local' } as never])
    const bucketB = store.getState().sshStateByEnvironment.get(ENV_B)
    const localLabels = store.getState().sshTargetLabels

    store.getState().retainEnvironmentSshState([ENV_B])

    expect(store.getState().sshStateByEnvironment.has(ENV_A)).toBe(false)
    expect(store.getState().sshStateByEnvironment.get(ENV_B)).toBe(bucketB)
    expect(store.getState().sshTargetLabels).toBe(localLabels)
  })

  it('detaching an environment through setRuntimeEnvironments drops its bucket', () => {
    const store = createTestStore()
    store.getState().setEnvironmentSshTargetsMetadata(ENV_A, [{ id: 'ssh-a', label: 'a-box' }])
    store.getState().setEnvironmentSshTargetsMetadata(ENV_B, [{ id: 'ssh-b', label: 'b-box' }])

    store.getState().setRuntimeEnvironments([{ id: ENV_B, name: 'B', createdAt: 0 } as never])

    expect(store.getState().sshStateByEnvironment.has(ENV_A)).toBe(false)
    expect(store.getState().sshStateByEnvironment.has(ENV_B)).toBe(true)
  })

  it('markEnvironmentSshStateStale downgrades to unknown but keeps labels for display', () => {
    const store = createTestStore()
    markReachable(store, ENV_A)
    store.getState().setEnvironmentSshTargetsMetadata(ENV_A, [{ id: 'ssh-a', label: 'a-box' }])
    store.getState().setEnvironmentSshConnectionState(ENV_A, 'ssh-a', connState('ssh-a'))
    expect(selectRuntimeAwareSshStatus(store.getState(), ENV_A, 'ssh-a')).toBe('connected')

    store.getState().markEnvironmentSshStateStale(ENV_A)

    const bucket = store.getState().sshStateByEnvironment.get(ENV_A)
    expect(bucket?.targetsHydrated).toBe(false)
    expect(bucket?.connectionStates.size).toBe(0)
    expect(bucket?.targetLabels.get('ssh-a')).toBe('a-box')
    // Un-hydrated bucket reads as unknown — no overlay, no removal evidence.
    expect(selectRuntimeAwareSshStatus(store.getState(), ENV_A, 'ssh-a')).toBeNull()
    expect(selectRuntimeAwareSshTargetRemoved(store.getState(), ENV_A, 'ssh-a')).toBe(false)
  })

  describe('selectors', () => {
    it('resolve the local maps when the owning environment is null', () => {
      const store = createTestStore()
      store.getState().setSshConnectionState('ssh-local', connState('ssh-local', 'disconnected'))
      store.getState().setSshTargetsMetadata([{ id: 'ssh-local', label: 'local box' } as never])
      // A same-id target in a bucket must not shadow the local resolution.
      markReachable(store, ENV_A)
      store.getState().setEnvironmentSshTargetsMetadata(ENV_A, [])

      const state = store.getState()
      expect(selectRuntimeAwareSshStatus(state, null, 'ssh-local')).toBe('disconnected')
      expect(selectRuntimeAwareSshTargetLabel(state, null, 'ssh-local')).toBe('local box')
      expect(selectRuntimeAwareSshTargetRemoved(state, null, 'ssh-local')).toBe(false)
      expect(selectRuntimeAwareSshTargetRemoved(state, null, 'ssh-gone')).toBe(true)
    })

    it('resolve the owning environment bucket, not local state, for a remote-owned target', () => {
      const store = createTestStore()
      markReachable(store, ENV_A)
      // Same target id exists locally as connected — must not leak into the
      // environment read.
      store.getState().setSshConnectionState('ssh-1', connState('ssh-1', 'connected'))
      store.getState().setEnvironmentSshTargetsMetadata(ENV_A, [{ id: 'ssh-1', label: 'devbox' }])
      store
        .getState()
        .setEnvironmentSshConnectionState(ENV_A, 'ssh-1', connState('ssh-1', 'disconnected'))

      const state = store.getState()
      expect(selectRuntimeAwareSshStatus(state, ENV_A, 'ssh-1')).toBe('disconnected')
      expect(selectRuntimeAwareSshTargetLabel(state, ENV_A, 'ssh-1')).toBe('devbox')
      expect(selectRuntimeAwareSshTargetRemoved(state, ENV_A, 'ssh-1')).toBe(false)
    })

    it('return unknown (null status) for an unreachable environment even with a hydrated bucket', () => {
      const store = createTestStore()
      markReachable(store, ENV_A)
      store.getState().setEnvironmentSshTargetsMetadata(ENV_A, [{ id: 'ssh-1', label: 'devbox' }])
      store
        .getState()
        .setEnvironmentSshConnectionState(ENV_A, 'ssh-1', connState('ssh-1', 'disconnected'))
      // Environment probe now records unreachable.
      store.getState().setRuntimeEnvironmentStatus(ENV_A, { status: null, checkedAt: Date.now() })

      const state = store.getState()
      expect(selectRuntimeAwareSshStatus(state, ENV_A, 'ssh-1')).toBeNull()
      expect(selectRuntimeAwareSshTargetRemoved(state, ENV_A, 'ssh-1')).toBe(false)
    })

    it('never report removal from an un-hydrated bucket, and report it from a hydrated one', () => {
      const store = createTestStore()
      markReachable(store, ENV_A)
      const before = store.getState()
      expect(selectRuntimeAwareSshTargetRemoved(before, ENV_A, 'ssh-ghost')).toBe(false)
      expect(selectRuntimeAwareSshStatus(before, ENV_A, 'ssh-ghost')).toBeNull()

      store.getState().setEnvironmentSshTargetsMetadata(ENV_A, [])
      const after = store.getState()
      expect(selectRuntimeAwareSshTargetRemoved(after, ENV_A, 'ssh-ghost')).toBe(true)
      // Removal tombstones win the label fallback for ghost hosts.
      store.getState().setEnvironmentRemovedSshTargetLabels(ENV_A, { 'ssh-ghost': 'old devbox' })
      expect(selectRuntimeAwareSshTargetLabel(store.getState(), ENV_A, 'ssh-ghost')).toBe(
        'old devbox'
      )
    })
  })
})
