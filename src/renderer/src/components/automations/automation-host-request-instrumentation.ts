/** Translate scheduler work into counters: legacy requests/dedupe/discards belong to an authority, never one stable host key. */

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
    // Key hits exactly like their joined request; legacy entries must not show per-key hits against zero requests.
    dedupeHit: (ref, querySupport) => {
      diagnostics.recordDedupeHit({
        authorityKey: automationAuthorityCatalogKey(ref.authority),
        stableKey: querySupport === 'legacy-unscoped' ? null : hostStableKey(ref)
      })
    },
    // Record wire cost before fencing; rejected payloads still consumed size and time.
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
