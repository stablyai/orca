import type { RuntimeCapability } from '../../../shared/protocol-version'
import type { RuntimeEnvironmentStatus } from '../store/slices/runtime-status-types'

/** Matches the async capability prober's status TTL in runtime-capability-cache.ts. */
export const STRUCTURED_CHAT_HOST_VERDICT_STALE_MS = 60_000

/**
 * Every reason a client may or may not open structured chat against a host.
 * The four `unknown-*` members mean "ask again", never "the host said no".
 */
export type StructuredChatHostVerdict =
  | 'unknown-checking'
  | 'unknown-no-entry'
  | 'unknown-unavailable'
  | 'unknown-stale'
  | 'supported'
  | 'host-refuses-capability'
  | 'host-policy-disabled'
  | 'host-disconnected'
  | 'version-or-auth-skew'

/** Effective admission published by the host; absent on hosts that predate publishing it. */
export type StructuredChatHostAdmission = { enabled: boolean } | undefined

export type StructuredChatHostVerdictInput = {
  entry: RuntimeEnvironmentStatus | undefined
  capability: RuntimeCapability
  admission: StructuredChatHostAdmission
  now?: number
}

export function isUnknownStructuredChatHostVerdict(verdict: StructuredChatHostVerdict): boolean {
  return verdict.startsWith('unknown-')
}

export function resolveStructuredChatHostVerdict({
  entry,
  capability,
  admission,
  now = Date.now()
}: StructuredChatHostVerdictInput): StructuredChatHostVerdict {
  const snapshot = entry?.snapshot
  // A dropped catalog/pairing-revision snapshot and a re-paired entry are both
  // silent windows on a healthy host, so absence is defined as unknown.
  if (!snapshot) {
    return 'unknown-no-entry'
  }
  if (snapshot.retired) {
    // The client disconnected this host; that outranks whatever blocked the last probe.
    return 'host-disconnected'
  }
  if (snapshot.verification === 'blocked') {
    return snapshot.blockedCode ? 'version-or-auth-skew' : 'unknown-unavailable'
  }
  if (snapshot.verification !== 'verified') {
    return snapshot.verification === 'checking' ? 'unknown-checking' : 'unknown-unavailable'
  }
  if (!snapshot.status) {
    return 'unknown-unavailable'
  }
  if (now - snapshot.checkedAt > STRUCTURED_CHAT_HOST_VERDICT_STALE_MS) {
    return 'unknown-stale'
  }
  if (snapshot.status.capabilities?.includes(capability) !== true) {
    return 'host-refuses-capability'
  }
  // An older host publishes no admission at all; that is unknown policy, not a refusal.
  return admission?.enabled === false ? 'host-policy-disabled' : 'supported'
}
