import { describe, expect, it } from 'vitest'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import {
  createTestStore,
  makeWorktree,
  seedStore,
  TEST_REPO
} from '@/store/slices/store-test-helpers'
import { getExplicitRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  selectWorktreeCardSshStatus,
  selectWorktreeCardSshTargetLabel
} from './worktree-card-ssh-status'

const ENV_HUB = 'env-hub'
const TARGET = 'ssh-hub-box'

function connState(status: SshConnectionState['status'] = 'connected'): SshConnectionState {
  return { targetId: TARGET, status, error: null, reconnectAttempt: 0 }
}

function markReachable(store: ReturnType<typeof createTestStore>, environmentId: string): void {
  store.getState().setRuntimeEnvironmentStatus(environmentId, {
    status: { runtimeId: environmentId } as RuntimeStatus,
    checkedAt: Date.now()
  })
}

function seedHubBucket(
  store: ReturnType<typeof createTestStore>,
  status: SshConnectionState['status'] = 'connected'
): void {
  markReachable(store, ENV_HUB)
  store.getState().setEnvironmentSshTargetsMetadata(ENV_HUB, [{ id: TARGET, label: 'hub-box' }])
  store.getState().setEnvironmentSshConnectionState(ENV_HUB, TARGET, connState(status))
}

describe('selectWorktreeCardSshStatus', () => {
  // Regression: paired clients mirror hub SSH state only into sshStateByEnvironment,
  // so a local-map read made every healthy hub worktree render "disconnected".
  it('reads the owning environment bucket, not the local maps, for hub-owned targets', () => {
    const store = createTestStore()
    seedHubBucket(store)
    expect(store.getState().sshConnectionStates.size).toBe(0)

    expect(selectWorktreeCardSshStatus(store.getState(), ENV_HUB, TARGET)).toBe('connected')
  })

  it('still surfaces a real disconnect reported by the hub', () => {
    const store = createTestStore()
    seedHubBucket(store, 'disconnected')

    expect(selectWorktreeCardSshStatus(store.getState(), ENV_HUB, TARGET)).toBe('disconnected')
  })

  it('reports unknown (null), not disconnected, while the hub bucket is unhydrated', () => {
    const store = createTestStore()
    markReachable(store, ENV_HUB)

    expect(selectWorktreeCardSshStatus(store.getState(), ENV_HUB, TARGET)).toBeNull()
  })

  it('reports unknown (null) when the owning environment is unreachable', () => {
    const store = createTestStore()
    store.getState().setEnvironmentSshTargetsMetadata(ENV_HUB, [{ id: TARGET, label: 'hub-box' }])
    store.getState().setEnvironmentSshConnectionState(ENV_HUB, TARGET, connState())

    expect(selectWorktreeCardSshStatus(store.getState(), ENV_HUB, TARGET)).toBeNull()
  })

  it('keeps local-map semantics for local worktrees (environmentId null)', () => {
    const store = createTestStore()
    store.setState({ sshConnectionStates: new Map([[TARGET, connState()]]) })

    expect(selectWorktreeCardSshStatus(store.getState(), null, TARGET)).toBe('connected')
    // Absent local state must keep today's pessimistic fallback.
    expect(selectWorktreeCardSshStatus(store.getState(), null, 'ssh-unknown')).toBe('disconnected')
  })

  it('returns null for runtime-owned target ids and missing connection ids', () => {
    const store = createTestStore()
    seedHubBucket(store)

    expect(selectWorktreeCardSshStatus(store.getState(), null, 'runtime-ssh-vm1')).toBeNull()
    expect(selectWorktreeCardSshStatus(store.getState(), ENV_HUB, 'runtime-ssh-vm1')).toBeNull()
    expect(selectWorktreeCardSshStatus(store.getState(), null, undefined)).toBeNull()
  })
})

describe('selectWorktreeCardSshTargetLabel', () => {
  it('reads the owning environment bucket label for hub-owned targets', () => {
    const store = createTestStore()
    seedHubBucket(store)
    expect(store.getState().sshTargetLabels.size).toBe(0)

    expect(selectWorktreeCardSshTargetLabel(store.getState(), ENV_HUB, TARGET)).toBe('hub-box')
  })

  it('keeps local-map semantics for local worktrees (environmentId null)', () => {
    const store = createTestStore()
    store.setState({ sshTargetLabels: new Map([[TARGET, 'my-box']]) })

    expect(selectWorktreeCardSshTargetLabel(store.getState(), null, TARGET)).toBe('my-box')
    // Absent local label must keep today's '' fallback (card falls back to repo.displayName).
    expect(selectWorktreeCardSshTargetLabel(store.getState(), null, 'ssh-unknown')).toBe('')
  })

  it('returns "" instead of the raw target id when the hub bucket has no label', () => {
    const store = createTestStore()
    markReachable(store, ENV_HUB)
    store.getState().setEnvironmentSshConnectionState(ENV_HUB, TARGET, connState())

    expect(selectWorktreeCardSshTargetLabel(store.getState(), ENV_HUB, TARGET)).toBe('')
  })

  it('falls back to the hub tombstone label for a target removed on the hub', () => {
    const store = createTestStore()
    markReachable(store, ENV_HUB)
    store.getState().setEnvironmentRemovedSshTargetLabels(ENV_HUB, { [TARGET]: 'old hub box' })

    expect(selectWorktreeCardSshTargetLabel(store.getState(), ENV_HUB, TARGET)).toBe('old hub box')
  })

  it('returns "" when there is no connection id', () => {
    const store = createTestStore()

    expect(selectWorktreeCardSshTargetLabel(store.getState(), null, undefined)).toBe('')
  })
})

describe('worktree card SSH status wiring', () => {
  it('resolves a runtime-hosted worktree to its hub environment whose bucket answers the card', () => {
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        [TEST_REPO.id]: [
          makeWorktree({
            id: 'wt-hub',
            repoId: TEST_REPO.id,
            hostId: toRuntimeExecutionHostId(ENV_HUB)
          })
        ]
      }
    })
    seedHubBucket(store)

    const environmentId = getExplicitRuntimeEnvironmentIdForWorktree(store.getState(), 'wt-hub')
    expect(environmentId).toBe(ENV_HUB)
    expect(selectWorktreeCardSshStatus(store.getState(), environmentId, TARGET)).toBe('connected')
    expect(selectWorktreeCardSshTargetLabel(store.getState(), environmentId, TARGET)).toBe(
      'hub-box'
    )
  })

  it('resolves a plain local worktree to no environment, keeping local-map reads', () => {
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        [TEST_REPO.id]: [makeWorktree({ id: 'wt-local', repoId: TEST_REPO.id })]
      }
    })

    expect(getExplicitRuntimeEnvironmentIdForWorktree(store.getState(), 'wt-local')).toBeNull()
  })
})
