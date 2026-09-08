/**
 * The scheduler's side of the cache counters: it knows which fence a call was
 * made under, and this knows what that means to the release gate.
 *
 * Keeping the translation here is what lets the scheduler stay a description of
 * when to fetch rather than of how each fetch is counted. The rule it enforces
 * on the scheduler's behalf: a legacy call is one request for its authority and
 * belongs to no stable key, on every counter that has a keyed form.
 */

import { hostStableKey } from '../../../../shared/automation-owner-key'
import type { StableAutomationCatalogRef } from '../../../../shared/automation-owner-ref'
import {
  automationAuthorityCatalogKey,
  type AutomationHostQuerySupport
} from './automation-host-catalog-types'
import type { AutomationHostRequestFence } from './automation-host-cache-types'
import {
  automationHostDiagnostics,
  measureAutomationHostResponseChars,
  type AutomationHostDiagnostics,
  type AutomationHostRequestTransport
} from './automation-host-diagnostics'

export type AutomationHostRequestInstrumentation = {
  /** Wall clock for request duration; kept apart from the scheduler's fake-time `now`. */
  startedAt: () => number
  /** Called where the request is sent, not where it is queued: a cancelled job never counts. */
  request: (fence: AutomationHostRequestFence, transport: AutomationHostRequestTransport) => void
  dedupeHit: (ref: StableAutomationCatalogRef, querySupport: AutomationHostQuerySupport) => void
  response: (
    fence: AutomationHostRequestFence,
    stableKey: string | null,
    startedAt: number,
    rows: number,
    payload: unknown
  ) => void
  /** A request that threw still spent the time; the slowest refreshes are usually these. */
  failed: (fence: AutomationHostRequestFence, stableKey: string | null, startedAt: number) => void
  /** One entry's share of a legacy answer, so per-host row counts survive the fan-out. */
  entryRows: (stableKey: string, rows: number) => void
  entryDiscarded: (fence: AutomationHostRequestFence) => void
  requestDiscarded: (
    fence: AutomationHostRequestFence,
    stableKey: string | null,
    outcome: 'commit' | 'failure'
  ) => void
}

export function createAutomationHostRequestInstrumentation(
  diagnostics: AutomationHostDiagnostics = automationHostDiagnostics,
  elapsed: () => number = () => performance.now()
): AutomationHostRequestInstrumentation {
  return {
    startedAt: elapsed,
    request: (fence, transport) => {
      diagnostics.recordRequest({
        authorityKey: fence.authorityKey,
        stableKey: transport === 'legacy' ? null : fence.stableKey,
        transport
      })
    },
    // Keyed exactly as the request it joined, or per-key invariants over the two
    // could not be written: a legacy host would read 0 requests against N hits.
    dedupeHit: (ref, querySupport) => {
      diagnostics.recordDedupeHit({
        authorityKey: automationAuthorityCatalogKey(ref.authority),
        stableKey: querySupport === 'legacy-unscoped' ? null : hostStableKey(ref)
      })
    },
    // Recorded before the fence decides: the payload crossed the wire either
    // way, and the size/duration budgets are about what was spent, not kept.
    response: (fence, stableKey, startedAt, rows, payload) => {
      diagnostics.recordResponse({
        authorityKey: fence.authorityKey,
        stableKey,
        rows,
        durationMs: elapsed() - startedAt,
        approxSerializedChars: diagnostics.measuringSerializedChars()
          ? measureAutomationHostResponseChars(payload)
          : undefined
      })
    },
    failed: (fence, stableKey, startedAt) => {
      diagnostics.recordFailedRequest({
        authorityKey: fence.authorityKey,
        stableKey,
        durationMs: elapsed() - startedAt
      })
    },
    entryRows: (stableKey, rows) => {
      diagnostics.recordEntryRows({ stableKey, rows })
    },
    entryDiscarded: (fence) => {
      diagnostics.recordDiscardedEntry({
        authorityKey: fence.authorityKey,
        stableKey: fence.stableKey
      })
    },
    requestDiscarded: (fence, stableKey, outcome) => {
      diagnostics.recordDiscardedRequest({
        authorityKey: fence.authorityKey,
        stableKey,
        outcome
      })
    }
  }
}
