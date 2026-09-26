/** Refusals for an orchestration party named by its Orca agent session id; each applies no effects. */
export const ORCHESTRATION_SESSION_CALLER_ERROR_CODES = {
  /** The request crossed a host boundary (a paired client, SSH, or WSL); session identity is same-host only. */
  hostBoundary: 'session_caller_host_boundary',
  /** No Orca agent session with that id exists on this host. */
  unknown: 'session_caller_unknown',
  /** The id is a provider's own session id, which rotates on `/clear`; the refusal names the Orca id. */
  providerId: 'session_caller_provider_id',
  /** The session exists but has no live owner here: released, switching owners, or unreconciled. */
  notLive: 'session_caller_not_live',
  /** A request with no session id named a chat's address as its caller. */
  chatNotDeclarable: 'session_caller_chat_not_declarable',
  /** A Dispatch named a chat as its assignee, which a chat cannot be yet. */
  chatNotDispatchable: 'session_chat_not_dispatchable'
} as const
