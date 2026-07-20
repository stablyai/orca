import { describe, expect, it } from 'vitest'
import { normalizeGitRemoteUrl } from '../../../../shared/git-remote-identity'
import {
  createSafeAutoForkSyncAttemptKeys,
  SafeAutoForkSyncAttemptRegistry,
  SAFE_AUTO_FORK_SYNC_COMPLETED_MAX_ENTRIES,
  SAFE_AUTO_FORK_SYNC_COOLDOWN_MS,
  type SafeAutoForkSyncAttemptIdentity
} from './safe-auto-fork-sync-attempts'

const baseIdentity: SafeAutoForkSyncAttemptIdentity = {
  profileId: 'profile-a',
  executionHostId: 'local',
  connectionId: null,
  repoId: 'repo-a',
  repoPath: '/repos/a',
  remoteCanonicalKey: 'github.com/fork/a',
  upstreamOwner: 'upstream-owner',
  upstreamRepo: 'upstream-repo'
}

function rememberCompleted(
  registry: SafeAutoForkSyncAttemptRegistry,
  key: string,
  attemptedAt: number
): void {
  const promise = Promise.resolve()
  registry.start(key, key, attemptedAt, promise)
  expect(registry.complete(key, promise)).toBe('completed')
}

describe('safe-auto fork sync attempt registry', () => {
  it('expires completed attempts at the cooldown boundary', () => {
    const registry = new SafeAutoForkSyncAttemptRegistry()
    rememberCompleted(registry, 'old', 0)
    rememberCompleted(registry, 'fresh', 1)

    registry.prune(SAFE_AUTO_FORK_SYNC_COOLDOWN_MS)

    expect(registry.hasCompleted('old')).toBe(false)
    expect(registry.hasCompleted('fresh')).toBe(true)
  })

  it('bounds ten thousand non-live attempts while preserving in-flight ownership', () => {
    const registry = new SafeAutoForkSyncAttemptRegistry()
    const inFlight = new Promise<void>(() => {})
    registry.start('in-flight', 'in-flight', 0, inFlight)

    for (let index = 0; index < 10_000; index += 1) {
      rememberCompleted(registry, `repo-${index}`, index)
    }

    expect(registry.inFlightCount).toBe(1)
    expect(registry.hasInFlight('in-flight')).toBe(true)
    expect(registry.completedCount).toBe(SAFE_AUTO_FORK_SYNC_COMPLETED_MAX_ENTRIES)
    expect(registry.hasCompleted('repo-0')).toBe(false)
    expect(registry.hasCompleted('repo-9999')).toBe(true)
  })

  it('preserves cooldowns for more than the history cap when every repo is still live', () => {
    const registry = new SafeAutoForkSyncAttemptRegistry()
    const liveKeys = Array.from(
      { length: SAFE_AUTO_FORK_SYNC_COMPLETED_MAX_ENTRIES + 1 },
      (_, index) => `live-${index}`
    )
    registry.prune(0, liveKeys)

    for (const key of liveKeys) {
      rememberCompleted(registry, key, 0)
    }

    expect(registry.completedCount).toBe(liveKeys.length)
    for (const key of liveKeys) {
      expect(registry.canStart(key, key, 1)).toBe(false)
    }
  })

  it('does not let an old settlement overwrite a newer attempt with the same key', () => {
    const registry = new SafeAutoForkSyncAttemptRegistry()
    const oldPromise = Promise.resolve()
    const newPromise = Promise.resolve()
    registry.start('repo', 'old-cooldown', 1, oldPromise)
    registry.start('repo', 'new-cooldown', 2, newPromise)

    expect(registry.complete('repo', oldPromise)).toBe('stale')
    expect(registry.hasInFlight('repo')).toBe(true)
    expect(registry.complete('repo', newPromise)).toBe('completed')
    expect(registry.hasCompleted('new-cooldown')).toBe(true)
  })

  it('queues changed cooldown identity behind the existing operation owner', () => {
    const registry = new SafeAutoForkSyncAttemptRegistry()
    const promise = Promise.resolve()
    registry.start('operation', 'upstream-a', 1, promise)

    expect(registry.canStart('operation', 'upstream-b', 2)).toBe(false)
    expect(registry.complete('operation', promise)).toBe('retry')
    expect(registry.hasCompleted('upstream-a')).toBe(true)
    expect(registry.canStart('operation', 'upstream-b', 2)).toBe(true)
  })

  it('retires completed cooldowns and preserves in-flight ownership until settlement', () => {
    const registry = new SafeAutoForkSyncAttemptRegistry()
    rememberCompleted(registry, 'completed', 0)
    const inFlight = Promise.resolve()
    registry.start('in-flight', 'in-flight', 0, inFlight)

    expect(registry.retire('completed')).toBe(true)
    expect(registry.canStart('completed', 'completed', 1)).toBe(true)
    expect(registry.retire('in-flight')).toBe(true)
    expect(registry.canStart('in-flight', 'in-flight', 1)).toBe(false)
    expect(registry.complete('in-flight', inFlight)).toBe('retry')
    expect(registry.canStart('in-flight', 'in-flight', 1)).toBe(true)
  })

  it('drops retry intent that predates retirement but keeps a later lifecycle request', () => {
    const registry = new SafeAutoForkSyncAttemptRegistry()
    const promise = Promise.resolve()
    registry.start('operation', 'old', 0, promise)
    expect(registry.canStart('operation', 'changed-before-removal', 1)).toBe(false)

    registry.retire('operation')
    expect(registry.complete('operation', promise)).toBe('retired')

    const replacementPromise = Promise.resolve()
    registry.start('operation', 'replacement', 2, replacementPromise)
    registry.retire('operation')
    expect(registry.canStart('operation', 're-added', 3)).toBe(false)
    expect(registry.complete('operation', replacementPromise)).toBe('retry')
  })

  it('keeps incremental non-live accounting exact across protection and retirement changes', () => {
    const registry = new SafeAutoForkSyncAttemptRegistry()
    registry.prune(0, ['a', 'b'])
    rememberCompleted(registry, 'a', 0)
    rememberCompleted(registry, 'b', 0)
    rememberCompleted(registry, 'c', 0)
    expect(registry.nonLiveHistoryCount).toBe(1)

    registry.prune(1, ['b', 'c'])
    expect(registry.nonLiveHistoryCount).toBe(1)
    registry.retire('a')
    expect(registry.nonLiveHistoryCount).toBe(0)

    registry.prune(2)
    expect(registry.nonLiveHistoryCount).toBe(2)
    registry.retire('b')
    registry.retire('c')
    expect(registry.nonLiveHistoryCount).toBe(0)
  })

  it('retires every completed identity from the removed operation lifecycle', () => {
    const registry = new SafeAutoForkSyncAttemptRegistry()
    const oldPromise = Promise.resolve()
    registry.start('operation', 'profile-a-upstream-a', 1, oldPromise)
    expect(registry.complete('operation', oldPromise)).toBe('completed')
    const currentPromise = Promise.resolve()
    registry.start('operation', 'profile-b-upstream-b', 2, currentPromise)

    expect(registry.retire('operation')).toBe(true)
    expect(registry.hasCompleted('profile-a-upstream-a')).toBe(false)
    expect(registry.complete('operation', currentPromise)).toBe('retired')
    expect(registry.canStart('operation', 'profile-a-upstream-a', 3)).toBe(true)
  })

  it('separates profile, host, repo, path, remote, and upstream identities', () => {
    const baseKeys = createSafeAutoForkSyncAttemptKeys(baseIdentity)
    const mutations: SafeAutoForkSyncAttemptIdentity[] = [
      { ...baseIdentity, profileId: 'profile-b' },
      { ...baseIdentity, executionHostId: 'ssh:host-a', connectionId: 'host-a' },
      { ...baseIdentity, executionHostId: 'runtime:env-a' },
      { ...baseIdentity, repoId: 'repo-b' },
      { ...baseIdentity, repoPath: '/repos/b' },
      { ...baseIdentity, remoteCanonicalKey: 'github.com/fork/b' },
      { ...baseIdentity, upstreamOwner: 'other-owner' },
      { ...baseIdentity, upstreamRepo: 'other-repo' }
    ]

    expect(
      new Set(mutations.map((identity) => createSafeAutoForkSyncAttemptKeys(identity).cooldownKey))
        .size
    ).toBe(mutations.length)
    for (const mutation of mutations) {
      expect(createSafeAutoForkSyncAttemptKeys(mutation).cooldownKey).not.toBe(baseKeys.cooldownKey)
    }
    expect(createSafeAutoForkSyncAttemptKeys(mutations[0]).operationKey).toBe(baseKeys.operationKey)
    expect(createSafeAutoForkSyncAttemptKeys(mutations[5]).operationKey).toBe(baseKeys.operationKey)
    expect(createSafeAutoForkSyncAttemptKeys(mutations[6]).operationKey).toBe(baseKeys.operationKey)
    expect(createSafeAutoForkSyncAttemptKeys(mutations[1]).operationKey).not.toBe(
      baseKeys.operationKey
    )
    expect(createSafeAutoForkSyncAttemptKeys(mutations[2]).operationKey).not.toBe(
      baseKeys.operationKey
    )
  })

  it('shares canonical SSH and HTTPS remotes without collapsing enterprise hosts', () => {
    const sshRemote = normalizeGitRemoteUrl('git@github.example.com:Team/Fork.git')
    const httpsRemote = normalizeGitRemoteUrl('https://github.example.com/Team/Fork.git')
    const otherHost = normalizeGitRemoteUrl('https://other.example.com/Team/Fork.git')

    expect(sshRemote).toBe(httpsRemote)
    expect(
      createSafeAutoForkSyncAttemptKeys({ ...baseIdentity, remoteCanonicalKey: sshRemote })
        .cooldownKey
    ).toBe(
      createSafeAutoForkSyncAttemptKeys({ ...baseIdentity, remoteCanonicalKey: httpsRemote })
        .cooldownKey
    )
    expect(
      createSafeAutoForkSyncAttemptKeys({ ...baseIdentity, remoteCanonicalKey: otherHost })
        .cooldownKey
    ).not.toBe(
      createSafeAutoForkSyncAttemptKeys({ ...baseIdentity, remoteCanonicalKey: sshRemote })
        .cooldownKey
    )
  })
})
