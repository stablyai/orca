// Why: suppress hot-loop failures while still detecting an in-place Git
// upgrade during a long Orca session without requiring a restart.
export const GIT_CAPABILITY_RETRY_INTERVAL_MS = 30 * 60_000

export type GitCapability =
  | 'for-each-ref-exclude'
  | 'merge-tree-merge-base'
  | 'merge-tree-write-tree'
  | 'rev-parse-path-format'
  | 'worktree-list-z'

type GitCapabilityProbeOutcome = 'supported' | 'unsupported' | 'unknown'

export class GitCapabilityCache {
  private readonly retryAfterByCapability = new Map<GitCapability, number>()
  private readonly probesByCapability = new Map<GitCapability, Promise<GitCapabilityProbeOutcome>>()
  private readonly supportedCapabilities = new Set<GitCapability>()

  shouldTry(capability: GitCapability, nowMs = Date.now()): boolean {
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

  rememberUnsupported(capability: GitCapability, nowMs = Date.now()): void {
    // Why: optimistic probes preserve newer Git behavior, but repeating a
    // known failure on every poll/search wastes subprocesses and trace space.
    this.supportedCapabilities.delete(capability)
    this.retryAfterByCapability.set(capability, nowMs + GIT_CAPABILITY_RETRY_INTERVAL_MS)
  }

  async runWithFallback<T>(
    capability: GitCapability,
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

    let settleProbe!: (outcome: GitCapabilityProbeOutcome) => void
    const probe = new Promise<GitCapabilityProbeOutcome>((resolve) => {
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
    }
  }

  clear(): void {
    this.retryAfterByCapability.clear()
    this.probesByCapability.clear()
    this.supportedCapabilities.clear()
  }

  private async runPreferredOrFallback<T>(
    capability: GitCapability,
    runPreferred: () => Promise<T>,
    runFallback: () => Promise<T>,
    isUnsupportedError: (error: unknown) => boolean,
    settleProbe?: (outcome: GitCapabilityProbeOutcome) => void
  ): Promise<T> {
    try {
      const result = await runPreferred()
      // A preferred callback can detect old Git's exit-zero option echo and
      // remember it as unsupported, so do not overwrite that stronger signal.
      const outcome = this.retryAfterByCapability.has(capability) ? 'unsupported' : 'supported'
      if (outcome === 'supported') {
        this.supportedCapabilities.add(capability)
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
