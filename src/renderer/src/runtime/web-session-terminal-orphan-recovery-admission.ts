import { measureUtf8ByteLength } from '../../../shared/utf8-byte-limits'

export const WEB_SESSION_ORPHAN_RECOVERY_MAX_ACTIVE = 4
export const WEB_SESSION_ORPHAN_RECOVERY_MAX_OWNERS = 64
export const WEB_SESSION_ORPHAN_RECOVERY_MAX_OWNER_KEY_BYTES = 64 * 1024
export const WEB_SESSION_ORPHAN_RECOVERY_MAX_TOTAL_KEY_BYTES = 1024 * 1024
export const WEB_SESSION_ORPHAN_RECOVERY_MAX_RETAINED_BYTES = 32 * 1024 * 1024

type RecoveryAdmissionLimits = {
  maxActive: number
  maxOwners: number
  maxOwnerKeyBytes: number
  maxTotalKeyBytes: number
  maxRetainedBytes: number
}

type RecoveryJob<T> = {
  retainedBytes: number
  run: () => Promise<T>
  resolve: (value: T | null) => void
}

type RecoveryOwner<T> = {
  activeBytes: number
  keyBytes: number
  pending: RecoveryJob<T> | null
  queued: boolean
  running: boolean
}

const DEFAULT_LIMITS: RecoveryAdmissionLimits = {
  maxActive: WEB_SESSION_ORPHAN_RECOVERY_MAX_ACTIVE,
  maxOwners: WEB_SESSION_ORPHAN_RECOVERY_MAX_OWNERS,
  maxOwnerKeyBytes: WEB_SESSION_ORPHAN_RECOVERY_MAX_OWNER_KEY_BYTES,
  maxTotalKeyBytes: WEB_SESSION_ORPHAN_RECOVERY_MAX_TOTAL_KEY_BYTES,
  maxRetainedBytes: WEB_SESSION_ORPHAN_RECOVERY_MAX_RETAINED_BYTES
}

export class WebSessionTerminalOrphanRecoveryAdmission<T> {
  private readonly owners = new Map<string, RecoveryOwner<T>>()
  private readonly readyOwnerKeys: string[] = []
  private active = 0
  private retainedBytes = 0
  private retainedKeyBytes = 0

  constructor(private readonly limits: RecoveryAdmissionLimits = DEFAULT_LIMITS) {
    for (const value of Object.values(limits)) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError('Orphan recovery admission limits must be positive integers')
      }
    }
  }

  schedule(key: string, retainedBytes: number, run: () => Promise<T>): Promise<T | null> {
    if (!Number.isSafeInteger(retainedBytes) || retainedBytes < 0) {
      return Promise.resolve(null)
    }
    const keyMeasurement = measureUtf8ByteLength(key, {
      stopAfterBytes: this.limits.maxOwnerKeyBytes
    })
    if (key.length === 0 || keyMeasurement.exceededLimit) {
      return Promise.resolve(null)
    }

    const existing = this.owners.get(key)
    if (existing) {
      const replacedBytes = existing.pending?.retainedBytes ?? 0
      if (retainedBytes > this.limits.maxRetainedBytes - (this.retainedBytes - replacedBytes)) {
        return Promise.resolve(null)
      }
      return new Promise<T | null>((resolve) => {
        if (existing.pending) {
          this.retainedBytes -= existing.pending.retainedBytes
          existing.pending.resolve(null)
        }
        existing.pending = { retainedBytes, run, resolve }
        this.retainedBytes += retainedBytes
        this.enqueue(key, existing)
      })
    }

    if (
      this.owners.size >= this.limits.maxOwners ||
      keyMeasurement.byteLength > this.limits.maxTotalKeyBytes - this.retainedKeyBytes ||
      retainedBytes > this.limits.maxRetainedBytes - this.retainedBytes
    ) {
      return Promise.resolve(null)
    }

    return new Promise<T | null>((resolve) => {
      const owner: RecoveryOwner<T> = {
        activeBytes: 0,
        keyBytes: keyMeasurement.byteLength,
        pending: { retainedBytes, run, resolve },
        queued: false,
        running: false
      }
      this.owners.set(key, owner)
      this.retainedBytes += retainedBytes
      this.retainedKeyBytes += keyMeasurement.byteLength
      this.enqueue(key, owner)
    })
  }

  evidence(): {
    active: number
    owners: number
    queued: number
    retainedBytes: number
    retainedKeyBytes: number
  } {
    return {
      active: this.active,
      owners: this.owners.size,
      queued: this.readyOwnerKeys.length,
      retainedBytes: this.retainedBytes,
      retainedKeyBytes: this.retainedKeyBytes
    }
  }

  reset(): void {
    this.readyOwnerKeys.length = 0
    for (const [key, owner] of this.owners) {
      owner.queued = false
      if (owner.pending) {
        this.retainedBytes -= owner.pending.retainedBytes
        owner.pending.resolve(null)
        owner.pending = null
      }
      if (!owner.running) {
        this.owners.delete(key)
        this.retainedKeyBytes -= owner.keyBytes
      }
    }
  }

  private enqueue(key: string, owner: RecoveryOwner<T>): void {
    if (!owner.running && !owner.queued && owner.pending) {
      owner.queued = true
      this.readyOwnerKeys.push(key)
    }
    this.drain()
  }

  private drain(): void {
    while (this.active < this.limits.maxActive) {
      const key = this.readyOwnerKeys.shift()
      if (key === undefined) {
        return
      }
      const owner = this.owners.get(key)
      if (!owner || !owner.queued || owner.running || !owner.pending) {
        continue
      }
      owner.queued = false
      void this.run(key, owner)
    }
  }

  private async run(key: string, owner: RecoveryOwner<T>): Promise<void> {
    const job = owner.pending
    if (!job) {
      return
    }
    owner.pending = null
    owner.running = true
    owner.activeBytes = job.retainedBytes
    this.active += 1
    try {
      job.resolve(await job.run())
    } catch {
      job.resolve(null)
    } finally {
      this.active -= 1
      this.retainedBytes -= owner.activeBytes
      owner.activeBytes = 0
      owner.running = false
      if (owner.pending) {
        this.enqueue(key, owner)
      } else if (this.owners.get(key) === owner) {
        this.owners.delete(key)
        this.retainedKeyBytes -= owner.keyBytes
      }
      this.drain()
    }
  }
}
