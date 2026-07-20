export const SAFE_AUTO_FORK_SYNC_COOLDOWN_MS = 10 * 60 * 1000
export const SAFE_AUTO_FORK_SYNC_COMPLETED_MAX_ENTRIES = 2048

export type SafeAutoForkSyncAttemptIdentity = {
  profileId: string | null
  executionHostId: string
  connectionId: string | null
  repoId: string
  repoPath: string
  remoteCanonicalKey: string | null
  upstreamOwner: string
  upstreamRepo: string
}

type InFlightAttempt = {
  cooldownKey: string
  attemptedAt: number
  promise: Promise<void>
  retired: boolean
  retryRequested: boolean
}

type CompletedAttempt = {
  operationKey: string
  attemptedAt: number
}

export type SafeAutoForkSyncAttemptKeys = {
  operationKey: string
  cooldownKey: string
}

export type SafeAutoForkSyncCompletion = 'completed' | 'retired' | 'retry' | 'stale'

export function createSafeAutoForkSyncAttemptKeys(
  identity: SafeAutoForkSyncAttemptIdentity
): SafeAutoForkSyncAttemptKeys {
  const operationKey = JSON.stringify([
    identity.executionHostId,
    identity.connectionId ?? '',
    identity.repoId,
    identity.repoPath
  ])
  return {
    operationKey,
    cooldownKey: JSON.stringify([
      operationKey,
      identity.profileId ?? '',
      identity.remoteCanonicalKey ?? '',
      identity.upstreamOwner.trim().toLowerCase(),
      identity.upstreamRepo.trim().toLowerCase()
    ])
  }
}

export class SafeAutoForkSyncAttemptRegistry {
  private readonly inFlight = new Map<string, InFlightAttempt>()
  private readonly completed = new Map<string, CompletedAttempt>()
  private readonly completedKeysByOperation = new Map<string, Set<string>>()
  private liveCooldownKeys = new Set<string>()
  private readonly nonLiveCompletedKeys = new Set<string>()

  public constructor(
    private readonly cooldownMs = SAFE_AUTO_FORK_SYNC_COOLDOWN_MS,
    private readonly maxCompletedEntries = SAFE_AUTO_FORK_SYNC_COMPLETED_MAX_ENTRIES
  ) {}

  public prune(now: number, liveCooldownKeys: Iterable<string> = []): void {
    this.liveCooldownKeys = new Set(liveCooldownKeys)
    this.nonLiveCompletedKeys.clear()
    for (const key of this.completed.keys()) {
      if (!this.liveCooldownKeys.has(key)) {
        this.nonLiveCompletedKeys.add(key)
      }
    }
    for (const [key, attempt] of this.completed) {
      if (now - attempt.attemptedAt >= this.cooldownMs) {
        this.deleteCompleted(key)
      }
    }
    this.evictCompletedOverflow()
  }

  public canStart(operationKey: string, cooldownKey: string, now: number): boolean {
    const current = this.inFlight.get(operationKey)
    if (current) {
      if (current.retired || current.cooldownKey !== cooldownKey) {
        current.retryRequested = true
      }
      return false
    }
    const completed = this.completed.get(cooldownKey)
    return completed === undefined || now - completed.attemptedAt >= this.cooldownMs
  }

  public start(
    operationKey: string,
    cooldownKey: string,
    attemptedAt: number,
    promise: Promise<void>
  ): void {
    this.deleteCompleted(cooldownKey)
    this.inFlight.set(operationKey, {
      cooldownKey,
      attemptedAt,
      promise,
      retired: false,
      retryRequested: false
    })
  }

  public complete(operationKey: string, promise: Promise<void>): SafeAutoForkSyncCompletion {
    const current = this.inFlight.get(operationKey)
    if (current?.promise !== promise) {
      return 'stale'
    }
    this.inFlight.delete(operationKey)
    if (current.retired) {
      return current.retryRequested ? 'retry' : 'retired'
    }
    this.rememberCompleted(operationKey, current.cooldownKey, current.attemptedAt)
    this.evictCompletedOverflow()
    return current.retryRequested ? 'retry' : 'completed'
  }

  public retire(operationKey: string): boolean {
    let retired = false
    const current = this.inFlight.get(operationKey)
    if (current) {
      current.retired = true
      current.retryRequested = false
      retired = true
    }
    for (const cooldownKey of this.completedKeysByOperation.get(operationKey) ?? []) {
      this.deleteCompleted(cooldownKey)
      retired = true
    }
    return retired
  }

  public hasInFlight(operationKey: string): boolean {
    return this.inFlight.has(operationKey)
  }

  public hasCompleted(cooldownKey: string): boolean {
    return this.completed.has(cooldownKey)
  }

  public get inFlightCount(): number {
    return this.inFlight.size
  }

  public get completedCount(): number {
    return this.completed.size
  }

  public get nonLiveHistoryCount(): number {
    return this.nonLiveCompletedKeys.size
  }

  private rememberCompleted(operationKey: string, cooldownKey: string, attemptedAt: number): void {
    this.deleteCompleted(cooldownKey)
    this.completed.set(cooldownKey, { operationKey, attemptedAt })
    if (!this.liveCooldownKeys.has(cooldownKey)) {
      this.nonLiveCompletedKeys.add(cooldownKey)
    }
    const keys = this.completedKeysByOperation.get(operationKey) ?? new Set<string>()
    keys.add(cooldownKey)
    this.completedKeysByOperation.set(operationKey, keys)
  }

  private deleteCompleted(cooldownKey: string): boolean {
    const completed = this.completed.get(cooldownKey)
    if (!completed) {
      return false
    }
    this.completed.delete(cooldownKey)
    this.nonLiveCompletedKeys.delete(cooldownKey)
    const keys = this.completedKeysByOperation.get(completed.operationKey)
    keys?.delete(cooldownKey)
    if (keys?.size === 0) {
      this.completedKeysByOperation.delete(completed.operationKey)
    }
    return true
  }

  private evictCompletedOverflow(): void {
    while (this.nonLiveCompletedKeys.size > this.maxCompletedEntries) {
      const oldestKey = this.nonLiveCompletedKeys.values().next().value
      if (oldestKey === undefined) {
        return
      }
      this.deleteCompleted(oldestKey)
    }
  }
}

const registriesByStoreOwner = new WeakMap<object, SafeAutoForkSyncAttemptRegistry>()

export function getSafeAutoForkSyncAttemptRegistry(
  storeOwner: object
): SafeAutoForkSyncAttemptRegistry {
  let registry = registriesByStoreOwner.get(storeOwner)
  if (!registry) {
    registry = new SafeAutoForkSyncAttemptRegistry()
    registriesByStoreOwner.set(storeOwner, registry)
  }
  return registry
}
