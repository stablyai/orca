import type { PairedE2EEAuthReply } from '../../../shared/paired-e2ee-client-handshake'
import { INSECURE_WEB_ORIGIN_AUTH_CODE } from '../../../shared/web-origin-security'
import type { WebRuntimeAuthFailureReason } from './web-runtime-client-error'
import type {
  WebRuntimeAuthPlan,
  WebRuntimeCredentialSource
} from './web-runtime-credential-source'

export type WebRuntimeAuthOutcome =
  | { kind: 'failed'; reason: WebRuntimeAuthFailureReason }
  // Storage trouble on the host: keep everything and reconnect with backoff.
  | { kind: 'retry' }

/**
 * Maps a sealed rejection to what the browser does. Only a device_revoked naming this
 * browser's own key deletes it; a downgraded host or bad proof keeps it for a later upgrade.
 */
export async function resolveWebRuntimeAuthRejection(
  plan: WebRuntimeAuthPlan | null,
  reply: Extract<PairedE2EEAuthReply, { kind: 'rejected' }>,
  source: WebRuntimeCredentialSource
): Promise<WebRuntimeAuthOutcome> {
  if (reply.errorCode === INSECURE_WEB_ORIGIN_AUTH_CODE) {
    return { kind: 'failed', reason: 'insecure-origin' }
  }
  if (plan?.kind !== 'device-key') {
    return { kind: 'failed', reason: 'unauthorized' }
  }
  if (reply.errorCode === 'registry_unavailable') {
    return { kind: 'retry' }
  }
  if (reply.errorCode === 'bad_auth') {
    return { kind: 'failed', reason: 'device-downgraded' }
  }
  if (
    reply.errorCode === 'device_revoked' &&
    reply.errorDeviceId === plan.deviceId &&
    (await source.deviceRevoked(plan.deviceId))
  ) {
    return { kind: 'failed', reason: 'device-revoked' }
  }
  return { kind: 'failed', reason: 'unauthorized' }
}
