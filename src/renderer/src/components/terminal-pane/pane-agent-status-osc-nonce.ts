import { AGENT_STATUS_OSC_NONCE_BYTES } from '../../../../shared/agent-status-osc-nonce'

/**
 * Per-pane secret stamped into pane env beside ORCA_PANE_KEY, so the pane's
 * process and its descendants can attest OSC 9999 agent-status payloads.
 *
 * Memoized per paneKey for the life of the app run, deliberately: a restart,
 * reattach, or detached-pane adoption re-enters the same pane and must present
 * the same nonce, or a still-running agent's payloads would start failing the
 * gate. Entries are therefore NOT evicted on pane close — one short string per
 * pane created this run, the same lifetime class as the other paneKey-keyed
 * renderer maps (cache timers, agent status). Main drops its copy with the PTY.
 */
const nonceByPaneKey = new Map<string, string>()

function mintNonce(): string {
  const bytes = new Uint8Array(AGENT_STATUS_OSC_NONCE_BYTES)
  crypto.getRandomValues(bytes)
  let hex = ''
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

export function getOrCreatePaneAgentStatusOscNonce(paneKey: string): string {
  const existing = nonceByPaneKey.get(paneKey)
  if (existing) {
    return existing
  }
  const nonce = mintNonce()
  nonceByPaneKey.set(paneKey, nonce)
  return nonce
}

/** Null when this pane never spawned through a nonce-stamping path. */
export function getPaneAgentStatusOscNonce(paneKey: string): string | null {
  return nonceByPaneKey.get(paneKey) ?? null
}

/** Test-only: production entries intentionally live for the app run (see above). */
export function resetPaneAgentStatusOscNonces(): void {
  nonceByPaneKey.clear()
}
