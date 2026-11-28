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
  'mail_requires_server_pairing',
  // The same mail is still being admitted there; nothing was applied, so the sender retries.
  'delivery_in_progress',
  // Mail with files to a bot chat that moved on while they were claimed; nothing was stored.
  'bot_chat_changed',
  // A refused bot mail whose file claims couldn't be given back, so a chat still holds its files.
  'peer_mail_files_kept',
  // A send --on that stored no mail after its files reached the server; data counts them.
  'peer_mail_not_sent'
] as const
