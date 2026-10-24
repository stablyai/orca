/** Count requests, dedupe, fence discards and response size/duration without retaining prompts/output. Legacy requests belong only to their authority; per-entry rows/discards must not be compared with request counts. */

export type AutomationHostRequestTransport = 'scoped' | 'legacy'

export type AutomationHostKeyCounters = {
  /** Pooled authority calls sent. Legacy calls land on the authority only. */
  requests: number
  scopedRequests: number
  legacyRequests: number
  /** Unpooled status.get probes dedupe per authority incarnation. Total relay calls = requests + capabilityProbes; only requests count toward the pool ceiling. */
  capabilityProbes: number
  /** Callers that joined a request already in flight, keyed like `requests`. */
  dedupeHits: number
  /** Requests whose answer landed nowhere because the fence rejected every entry. */
  discardedCommits: number
  discardedFailures: number
  /** Per-entry rejections; one legacy response can reject many, unlike requests/responses. */
  discardedEntries: number
  responses: number
  /** Requests that threw. `durationMsTotal` spans these too. */
  failures: number
  /** Totals/authority buckets count response rows once; key buckets count attributed rows, including legacy fan-out with zero per-key requests. */
  rows: number
  /** See `serializedCharsMeasured`; 0 also means "not measured". */
  approxSerializedChars: number
  /** Spans every completed request; the denominator is `responses + failures`. */
  durationMsTotal: number
  durationMsMax: number
}

export type AutomationHostDiagnosticsSnapshot = {
  totals: AutomationHostKeyCounters
  /** Evicted buckets can trail cumulative totals; their sum is only a lower bound. */
  byAuthority: Record<string, AutomationHostKeyCounters>
  byStableKey: Record<string, AutomationHostKeyCounters>
  /** Reserialization can disturb the 50ms budget, so opt in; false means unmeasured, not zero. */
  serializedCharsMeasured: boolean
}

export type AutomationHostRequestRecord = {
  authorityKey: string
  /** Null for a legacy authority call: it answers for every key at once. */
  stableKey: string | null
  transport: AutomationHostRequestTransport
}

export type AutomationHostResponseRecord = {
  authorityKey: string
  /** Null for a legacy authority answer, which belongs to no single key. */
  stableKey: string | null
  rows: number
  durationMs: number
  /** UTF-16 code units of the re-serialized payload, when measurement is on. */
  approxSerializedChars?: number
}

export type AutomationHostFailureRecord = {
  authorityKey: string
  stableKey: string | null
  durationMs: number
}

export type AutomationHostDiscardRecord = {
  authorityKey: string
  stableKey: string | null
  outcome: 'commit' | 'failure'
}

export type AutomationHostDiagnostics = {
  recordRequest: (record: AutomationHostRequestRecord) => void
  /** Keyed by authority alone: the probe answers for the host, not for one entry. */
  recordCapabilityProbe: (record: { authorityKey: string }) => void
  recordDedupeHit: (record: { authorityKey: string; stableKey: string | null }) => void
  recordResponse: (record: AutomationHostResponseRecord) => void
  recordFailedRequest: (record: AutomationHostFailureRecord) => void
  /** Rows one entry took from a legacy answer; touches that key's bucket only. */
  recordEntryRows: (record: { stableKey: string; rows: number }) => void
  recordDiscardedRequest: (record: AutomationHostDiscardRecord) => void
  recordDiscardedEntry: (record: { authorityKey: string; stableKey: string }) => void
  /** True only while measuring; callers skip the serialization cost otherwise. */
  measuringSerializedChars: () => boolean
  setMeasureSerializedChars: (enabled: boolean) => void
  snapshot: () => AutomationHostDiagnosticsSnapshot
  reset: () => void
}

// Bound host-churn memory well above the 50-host measurement fixture.
const MAX_TRACKED_KEYS = 512

function emptyCounters(): AutomationHostKeyCounters {
  return {
    requests: 0,
    scopedRequests: 0,
    legacyRequests: 0,
    capabilityProbes: 0,
    dedupeHits: 0,
    discardedCommits: 0,
    discardedFailures: 0,
    discardedEntries: 0,
    responses: 0,
    failures: 0,
    rows: 0,
    approxSerializedChars: 0,
    durationMsTotal: 0,
    durationMsMax: 0
  }
}

export function createAutomationHostDiagnostics(
  maxTrackedKeys = MAX_TRACKED_KEYS
): AutomationHostDiagnostics {
  const totals = emptyCounters()
  const byAuthority = new Map<string, AutomationHostKeyCounters>()
  const byStableKey = new Map<string, AutomationHostKeyCounters>()
  let measureSerializedChars = false

  const bucket = (
    buckets: Map<string, AutomationHostKeyCounters>,
    key: string
  ): AutomationHostKeyCounters => {
    const existing = buckets.get(key)
    if (existing) {
      return existing
    }
    // Evict first-seen keys without hot-path LRU reinsertion; the 512-key cap exceeds the 50-host fixture.
    if (buckets.size >= maxTrackedKeys) {
      const oldest = buckets.keys().next()
      if (!oldest.done) {
        buckets.delete(oldest.value)
      }
    }
    const created = emptyCounters()
    buckets.set(key, created)
    return created
  }

  const targets = (
    authorityKey: string,
    stableKey: string | null
  ): readonly AutomationHostKeyCounters[] =>
    stableKey === null
      ? [totals, bucket(byAuthority, authorityKey)]
      : [totals, bucket(byAuthority, authorityKey), bucket(byStableKey, stableKey)]

  const toRecord = (
    buckets: Map<string, AutomationHostKeyCounters>
  ): Record<string, AutomationHostKeyCounters> =>
    Object.fromEntries([...buckets].map(([key, counters]) => [key, { ...counters }]))

  const addDuration = (counters: AutomationHostKeyCounters, durationMs: number): void => {
    counters.durationMsTotal += durationMs
    counters.durationMsMax = Math.max(counters.durationMsMax, durationMs)
  }

  return {
    recordRequest: ({ authorityKey, stableKey, transport }) => {
      for (const counters of targets(authorityKey, stableKey)) {
        counters.requests += 1
        if (transport === 'legacy') {
          counters.legacyRequests += 1
        } else {
          counters.scopedRequests += 1
        }
      }
    },
    recordCapabilityProbe: ({ authorityKey }) => {
      for (const counters of targets(authorityKey, null)) {
        counters.capabilityProbes += 1
      }
    },
    recordDedupeHit: ({ authorityKey, stableKey }) => {
      for (const counters of targets(authorityKey, stableKey)) {
        counters.dedupeHits += 1
      }
    },
    recordResponse: ({ authorityKey, stableKey, rows, durationMs, approxSerializedChars }) => {
      for (const counters of targets(authorityKey, stableKey)) {
        counters.responses += 1
        counters.rows += rows
        counters.approxSerializedChars += approxSerializedChars ?? 0
        addDuration(counters, durationMs)
      }
    },
    recordFailedRequest: ({ authorityKey, stableKey, durationMs }) => {
      for (const counters of targets(authorityKey, stableKey)) {
        counters.failures += 1
        addDuration(counters, durationMs)
      }
    },
    recordEntryRows: ({ stableKey, rows }) => {
      bucket(byStableKey, stableKey).rows += rows
    },
    recordDiscardedRequest: ({ authorityKey, stableKey, outcome }) => {
      for (const counters of targets(authorityKey, stableKey)) {
        if (outcome === 'commit') {
          counters.discardedCommits += 1
        } else {
          counters.discardedFailures += 1
        }
      }
    },
    recordDiscardedEntry: ({ authorityKey, stableKey }) => {
      for (const counters of targets(authorityKey, stableKey)) {
        counters.discardedEntries += 1
      }
    },
    measuringSerializedChars: () => measureSerializedChars,
    setMeasureSerializedChars: (enabled) => {
      measureSerializedChars = enabled
    },
    snapshot: () => ({
      totals: { ...totals },
      byAuthority: toRecord(byAuthority),
      byStableKey: toRecord(byStableKey),
      serializedCharsMeasured: measureSerializedChars
    }),
    reset: () => {
      Object.assign(totals, emptyCounters())
      byAuthority.clear()
      byStableKey.clear()
    }
  }
}

/** Shared instance the scheduler and list client write to when nothing is injected. */
export const automationHostDiagnostics = createAutomationHostDiagnostics()

/** Measure reserialized UTF-16 code units, not wire bytes. Caller gates the cost; unserializable responses return undefined rather than a misleading zero. */
export function measureAutomationHostResponseChars(payload: unknown): number | undefined {
  try {
    return JSON.stringify(payload)?.length
  } catch {
    return undefined
  }
}

export type AutomationHostDiagnosticsBridge = {
  report: () => AutomationHostDiagnosticsSnapshot
  measureSerializedChars: (enabled?: boolean) => string
  reset: () => string
}

type AutomationHostDiagnosticsWindow = Window & {
  __orcaAutomationHostDiagnostic?: AutomationHostDiagnosticsBridge
}

export function installAutomationHostDiagnostic(): void {
  if (typeof window === 'undefined') {
    return
  }
  const target = window as AutomationHostDiagnosticsWindow
  if (target.__orcaAutomationHostDiagnostic) {
    return
  }
  target.__orcaAutomationHostDiagnostic = {
    report: () => {
      const snapshot = automationHostDiagnostics.snapshot()
      console.log('[orca] automation host cache diagnostics', snapshot)
      return snapshot
    },
    measureSerializedChars: (enabled = true) => {
      automationHostDiagnostics.setMeasureSerializedChars(enabled)
      return `Automation host response sizing ${enabled ? 'on' : 'off'}.`
    },
    reset: () => {
      automationHostDiagnostics.reset()
      return 'Automation host cache diagnostics reset.'
    }
  }
}
