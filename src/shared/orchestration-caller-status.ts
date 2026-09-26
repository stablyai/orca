/**
 * The calling agent's own orchestration address, as the host resolved it from the identity injected
 * into the caller's environment. Never from a flag, and opaque: a chat and a terminal agent get the
 * same shape. `orca status --json` reports it as `caller`.
 */
export type OrchestrationCallerAddress = {
  address: string
  /** False for a handle this process kept across a remint or a window reload. */
  live: boolean
}

/** The host refused the session this process names, so it cannot act as it right now. */
export type OrchestrationCallerRefusal = {
  live: false
  refusal: { code: string; message: string }
}

/**
 * `null`: this process carries no orchestration identity. Absent from a status result: nothing was
 * resolved, because the runtime was unreachable or the host predates `orchestration.callerShow`.
 */
export type CliStatusCaller = OrchestrationCallerAddress | OrchestrationCallerRefusal | null

export type OrchestrationCallerShowResult = { caller: OrchestrationCallerAddress | null }

/** `orchestration.sessionAddress`: the `session:<id>` another agent reaches a session's chat at. */
export type OrchestrationSessionAddressResult = { address: string }
