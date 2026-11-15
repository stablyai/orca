/** Codes a paired-server call keeps end to end, so callers can tell a stale pairing from an old or unreachable server. */
export const ORCHESTRATION_FEDERATION_ERROR_CODES = [
  'server_required',
  'worktree_not_found_on_server',
  'resource_server_mismatch',
  'peer_changed',
  'remote_runtime_unavailable',
  'runtime_timeout',
  'invalid_runtime_response',
  'capability_unsupported',
  'relay_quota_exceeded',
  'server_mail_unsupported',
  'mail_requires_server_pairing'
] as const
