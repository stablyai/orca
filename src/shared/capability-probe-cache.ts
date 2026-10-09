/**
 * Optimistic capability probing with a bounded retry window and in-flight
 * probe dedupe.
 *
 * Extracted from GitCapabilityCache so every host-capability cache in the tree
 * gets the same three behaviors: probe once, remember only a positive absence
 * signal, and let a concurrent caller wait on the probe already running rather
 * than starting a duplicate one.
 */
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
    // Why: optimistic probes preserve newer behavior, but repeating a known
    // failure on every poll/search wastes subprocesses and trace space.
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
      // Why: supported commands are real work, not disposable probes. Let
      // sibling repo/SSH calls retain their intended concurrency.
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
      // Backstop: `isUnsupportedError` or `rememberUnsupported` can throw
      // before the settle below them runs; waiters must not hang behind it.
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
      // A preferred callback can detect a weaker positive signal (old Git's
      // exit-zero option echo) and remember it as unsupported, so do not
      // overwrite that stronger signal.
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
