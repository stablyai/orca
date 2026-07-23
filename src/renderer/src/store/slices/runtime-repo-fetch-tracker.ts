import { measureUtf8ByteLength } from '../../../../shared/utf8-byte-limits'

export type RuntimeRepoFetchTrackerBounds = {
  maxEnvironments: number
  maxEnvironmentIdBytes: number
  maxTotalEnvironmentIdBytes: number
}

export const DEFAULT_RUNTIME_REPO_FETCH_TRACKER_BOUNDS: RuntimeRepoFetchTrackerBounds = {
  maxEnvironments: 8_192,
  maxEnvironmentIdBytes: 64 * 1024,
  maxTotalEnvironmentIdBytes: 1024 * 1024
}

type RuntimeRepoFetchClaim = {
  token: symbol
  keyBytes: number
}

export class RuntimeRepoFetchTracker {
  private readonly claims = new Map<string, RuntimeRepoFetchClaim>()
  private retainedKeyBytes = 0

  constructor(
    private readonly bounds: RuntimeRepoFetchTrackerBounds = DEFAULT_RUNTIME_REPO_FETCH_TRACKER_BOUNDS
  ) {
    if (
      !Number.isSafeInteger(bounds.maxEnvironments) ||
      bounds.maxEnvironments < 1 ||
      !Number.isSafeInteger(bounds.maxEnvironmentIdBytes) ||
      bounds.maxEnvironmentIdBytes < 1 ||
      !Number.isSafeInteger(bounds.maxTotalEnvironmentIdBytes) ||
      bounds.maxTotalEnvironmentIdBytes < 1
    ) {
      throw new RangeError('Runtime repo fetch tracker bounds must be positive integers')
    }
  }

  begin(environmentId: string): symbol | null {
    const existing = this.claims.get(environmentId)
    if (existing) {
      const token = Symbol()
      this.claims.set(environmentId, { ...existing, token })
      return token
    }
    const measurement = measureUtf8ByteLength(environmentId, {
      stopAfterBytes: this.bounds.maxEnvironmentIdBytes
    })
    if (
      measurement.exceededLimit ||
      this.claims.size >= this.bounds.maxEnvironments ||
      this.retainedKeyBytes + measurement.byteLength > this.bounds.maxTotalEnvironmentIdBytes
    ) {
      return null
    }
    const token = Symbol()
    this.claims.set(environmentId, { token, keyBytes: measurement.byteLength })
    this.retainedKeyBytes += measurement.byteLength
    return token
  }

  isCurrent(environmentId: string, token: symbol): boolean {
    return this.claims.get(environmentId)?.token === token
  }

  end(environmentId: string, token: symbol): void {
    const current = this.claims.get(environmentId)
    if (current?.token !== token) {
      return
    }
    this.claims.delete(environmentId)
    this.retainedKeyBytes -= current.keyBytes
  }

  evidence(): { environments: number; keyBytes: number } {
    return {
      environments: this.claims.size,
      keyBytes: this.retainedKeyBytes
    }
  }
}
