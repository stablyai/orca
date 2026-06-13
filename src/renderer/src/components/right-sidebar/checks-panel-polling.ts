import type { PRCheckDetail } from '../../../../shared/types'

export const CHECKS_PANEL_BASE_POLL_INTERVAL_MS = 30_000
export const CHECKS_PANEL_MAX_POLL_INTERVAL_MS = 120_000

function checkSignatureKey(check: PRCheckDetail): string {
  return JSON.stringify([check.name, check.status, check.conclusion])
}

export function nextChecksPanelPollInterval(input: {
  checks: PRCheckDetail[]
  previousSignature: string
  currentIntervalMs: number
}): { intervalMs: number; signature: string } {
  // Why: providers may reorder unchanged checks; backoff should only reset when
  // the check state changes, not when the array order flaps.
  const signature = JSON.stringify(input.checks.map((check) => checkSignatureKey(check)).sort())

  // Why: an empty list often means CI has not reported yet; keep polling at the
  // baseline so the panel recovers quickly instead of backing off.
  if (input.checks.length === 0) {
    return { intervalMs: CHECKS_PANEL_BASE_POLL_INTERVAL_MS, signature }
  }

  return {
    intervalMs:
      signature === input.previousSignature
        ? Math.min(input.currentIntervalMs * 2, CHECKS_PANEL_MAX_POLL_INTERVAL_MS)
        : CHECKS_PANEL_BASE_POLL_INTERVAL_MS,
    signature
  }
}
