import type { PRCheckDetail } from '../../../../shared/types'

export const CHECKS_PANEL_BASE_POLL_INTERVAL_MS = 30_000
export const CHECKS_PANEL_MAX_POLL_INTERVAL_MS = 120_000

export function nextChecksPanelPollInterval(input: {
  checks: PRCheckDetail[]
  previousSignature: string
  currentIntervalMs: number
}): { intervalMs: number; signature: string } {
  const signature = JSON.stringify(
    input.checks.map((check) => `${check.name}:${check.status}:${check.conclusion}`)
  )

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
