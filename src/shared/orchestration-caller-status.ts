/**
 * The calling agent's Orca session ID (`orca_session_id:<id>`), as the host resolved it from the
 * session id injected into the caller's environment; never from a flag. Terminal agents have none
 * yet. `orca status --json` reports it as `caller`.
 */
export type OrchestrationCallerSession = {
  orcaSessionId: string
  live: boolean
}

/** The host refused the session this process names, so it cannot act as it right now. */
export type OrchestrationCallerRefusal = {
  live: false
  refusal: { code: string; message: string }
}

/**
 * Absent from a status result when there is nothing to show: not a session, an unreachable
 * runtime, or a host that predates `orchestration.callerShow`.
 */
export type CliStatusCaller = OrchestrationCallerSession | OrchestrationCallerRefusal

/** `null`: the caller is not an Orca session. */
export type OrchestrationCallerShowResult = { caller: OrchestrationCallerSession | null }

/** `orchestration.sessionAddress`: a session's Orca session ID, its `/clear` root's. */
export type OrchestrationSessionAddressResult = { orcaSessionId: string }

/** Where a party is now: a chat at its `/clear` lineage's live session, or a terminal. */
export type OrchestrationPartyLocation =
  | { kind: 'chat'; sessionId: string; worktreeId: string }
  | { kind: 'terminal'; handle: string }

/** `orchestration.partyLocation`: a null location is a party this host does not find. `lost` says
 *  it proved that party gone, and what it was; absent, the host cannot tell (one it does not run). */
export type OrchestrationPartyLocationResult = {
  location: OrchestrationPartyLocation | null
  lost?: 'chat' | 'terminal'
}
