/** Unconfirmed client-local shutdown, replayed only through the legacy relay bridge for a closed tab’s surviving shell; downgrades replay it too. */
export type SshPendingPtyKill = {
  requestedAt: number
  /** Fence the intended incarnation: legacy pty-N IDs recycle after relay restart (#16970).
   * Current relays enforce it; preflight listProcesses also protects older relays that ignore the field.
   * Only epoch-scoped pty2: IDs may omit it because they cannot recur across starts. */
  incarnationId?: string
  /** Replays attempted since. Diagnostic; the TTL, not this, is the bound. */
  attempts: number
}

/** pty2:<epoch>:<n> has a fresh epoch per start; legacy pty-N IDs recycle. */
export function isEpochScopedRelayPtyId(relayPtyId: string): boolean {
  return relayPtyId.startsWith('pty2:')
}

/** The strict lease loader strips unknown fields; colocate admission so persistence cannot silently lose pending kills. */
export function normalizeSshPendingPtyKill(
  value: unknown,
  relayPtyId: string
): SshPendingPtyKill | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const raw = value as Partial<SshPendingPtyKill>
  if (typeof raw.requestedAt !== 'number' || !Number.isFinite(raw.requestedAt)) {
    return null
  }
  const attempts = typeof raw.attempts === 'number' && raw.attempts >= 0 ? raw.attempts : 0
  if (raw.incarnationId === undefined && isEpochScopedRelayPtyId(relayPtyId)) {
    return { requestedAt: raw.requestedAt, attempts }
  }
  // Never retain an unfenced kill for a recyclable ID.
  if (
    typeof raw.incarnationId !== 'string' ||
    !raw.incarnationId ||
    raw.incarnationId.length > 128
  ) {
    return null
  }
  return { requestedAt: raw.requestedAt, incarnationId: raw.incarnationId, attempts }
}
