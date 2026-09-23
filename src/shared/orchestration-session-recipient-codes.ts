/**
 * Refusals for mail addressed to an agent session (`session:<id>`, or a bare Orca session id).
 * Each is issued at recipient routing, before any message is stored.
 */
export const ORCHESTRATION_SESSION_RECIPIENT_ERROR_CODES = {
  /** The session runs on another host; mail reaches a session only on the host that runs it. */
  hostBoundary: 'session_recipient_host_boundary',
  /** No Orca agent session with that id exists on this host, or it cannot be verified. */
  unknown: 'session_recipient_unknown',
  /** The id is a provider's own session id, which rotates on `/clear`; the refusal names the Orca id. */
  providerId: 'session_recipient_provider_id',
  /** The session's chat was closed, or `/clear` replaced it with another session. */
  ended: 'session_recipient_ended'
} as const
