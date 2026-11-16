/** Deduplicate optimistic probes; remember unsupported evidence for a bounded retry window and let concurrent callers await the same probe. */
export type CapabilityProbeOutcome = 'supported' | 'unsupported' | 'unknown'

export class CapabilityProbeCache<TCapability> {
  private readonly retryAfterByCapability = new Map<TCapability, number>()
  private readonly probesByCapability = new Map<TCapability, Promise<CapabilityProbeOutcome>>()
  private readonly supportedCapabilities = new Set<TCapability>()

  constructor(
    private readonly retryIntervalMs: number,
    private readonly maxEntries = Number.POSITIVE_INFINITY
  ) {}

  shouldTry(capability: TCapability, nowMs = Date.now()): boolean {
    const retryAfterMs = this.retryAfterByCapability.get(capability)
    if (retryAfterMs === undefined) {
      return true
    }
    if (nowMs < retryAfterMs) {
      return false
    }
    this.retryAfterByCapability.delete(capability)
    return true
  }

  isKnownSupported(capability: TCapability): boolean {
    return this.supportedCapabilities.has(capability)
  }

  rememberSupported(capability: TCapability): void {
    this.retryAfterByCapability.delete(capability)
    this.supportedCapabilities.delete(capability)
    this.supportedCapabilities.add(capability)
    this.trimSettledEntries()
  }

  rememberUnsupported(capability: TCapability, nowMs = Date.now()): void {
    // Cache known absence to avoid repeating failed subprocesses on every poll/search.
    this.supportedCapabilities.delete(capability)
    this.retryAfterByCapability.set(capability, nowMs + this.retryIntervalMs)
    this.trimSettledEntries()
  }

  async runWithFallback<T>(
    capability: TCapability,
    runPreferred: () => Promise<T>,
    runFallback: () => Promise<T>,
    isUnsupportedError: (error: unknown) => boolean
  ): Promise<T> {
    if (this.supportedCapabilities.has(capability)) {
      // Supported commands are real work; preserve concurrency for sibling repo/SSH calls.
      return this.runPreferredOrFallback(capability, runPreferred, runFallback, isUnsupportedError)
    }
    if (!this.shouldTry(capability)) {
      return runFallback()
    }

    const inFlightProbe = this.probesByCapability.get(capability)
    if (inFlightProbe) {
      const outcome = await inFlightProbe
      if (outcome === 'unsupported' || !this.shouldTry(capability)) {
        return runFallback()
      }
      return this.runPreferredOrFallback(capability, runPreferred, runFallback, isUnsupportedError)
    }

    let settleProbe!: (outcome: CapabilityProbeOutcome) => void
    const probe = new Promise<CapabilityProbeOutcome>((resolve) => {
      settleProbe = resolve
    })
    this.probesByCapability.set(capability, probe)
    try {
      return await this.runPreferredOrFallback(
        capability,
        runPreferred,
        runFallback,
        isUnsupportedError,
        settleProbe
      )
    } finally {
      if (this.probesByCapability.get(capability) === probe) {
        this.probesByCapability.delete(capability)
      }
      // Settle waiters even if unsupported classification or caching throws.
      settleProbe('unknown')
    }
  }

  clear(): void {
    this.retryAfterByCapability.clear()
    this.probesByCapability.clear()
    this.supportedCapabilities.clear()
  }

  private trimSettledEntries(): void {
    while (this.supportedCapabilities.size > this.maxEntries) {
      const oldest = this.supportedCapabilities.values().next()
      if (oldest.done) {
        break
      }
      this.supportedCapabilities.delete(oldest.value)
    }
    while (this.retryAfterByCapability.size > this.maxEntries) {
      const oldest = this.retryAfterByCapability.keys().next()
      if (oldest.done) {
        break
      }
      this.retryAfterByCapability.delete(oldest.value)
    }
  }

  private async runPreferredOrFallback<T>(
    capability: TCapability,
    runPreferred: () => Promise<T>,
    runFallback: () => Promise<T>,
    isUnsupportedError: (error: unknown) => boolean,
    settleProbe?: (outcome: CapabilityProbeOutcome) => void
  ): Promise<T> {
    try {
      const result = await runPreferred()
      // A preferred callback may detect exit-zero option echo and record unsupported; preserve that stronger evidence.
      const outcome = this.retryAfterByCapability.has(capability) ? 'unsupported' : 'supported'
      if (outcome === 'supported') {
        this.rememberSupported(capability)
      }
      settleProbe?.(outcome)
      return result
    } catch (error) {
      if (!isUnsupportedError(error)) {
        settleProbe?.('unknown')
        throw error
      }
      this.rememberUnsupported(capability)
      settleProbe?.('unsupported')
      return runFallback()
    }
  }
}
