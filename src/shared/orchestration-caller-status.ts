/**
 * The calling agent's own orchestration address, as the host resolved it from the identity injected
 * into the caller's environment: its Orca session id, else its terminal handle. Never from a flag.
 * `orca status --json` reports it as `caller`, so any agent can learn the address others reach it by.
 */
export type OrchestrationCallerAddress =
  | {
      kind: 'session'
      /** `session:<id>`: one spelling for every session, a structured worker included. */
      address: string
      sessionId: string
      /** The host resolves a session only while its lease is live; otherwise it refuses. */
      live: true
    }
  | {
      kind: 'terminal'
      address: string
      /** False for a handle this process kept across a remint or a window reload. */
      live: boolean
    }

/** The host refused the session this process names, so it cannot act as it right now. */
export type OrchestrationCallerRefusal = {
  kind: 'session'
  sessionId: string
  live: false
  refusal: { code: string; message: string }
}

/**
 * `null`: this process carries no orchestration identity. Absent from a status result: nothing was
 * resolved, because the runtime was unreachable or the host predates `orchestration.callerShow`.
 */
export type CliStatusCaller = OrchestrationCallerAddress | OrchestrationCallerRefusal | null

export type OrchestrationCallerShowResult = { caller: OrchestrationCallerAddress | null }
