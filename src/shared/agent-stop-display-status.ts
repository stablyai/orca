// What an agent's row, chat or composer shows about a person's Stop: one rule for every surface,
// so none of them combines the host's flag and this client's own press on its own.

export type AgentStopDisplayStatus = 'stopping' | 'working' | 'not-working'

/** `stopping` while the agent works and either the host says a person's Stop is ending its turn
 *  or this client's own Stop request is still in flight; the host's flag is never shown on a
 *  row that is not working. */
export function agentStopDisplayStatus(input: {
  working: boolean
  hostStopping?: boolean
  stopPressed?: boolean
}): AgentStopDisplayStatus {
  if (!input.working) {
    return 'not-working'
  }
  return input.hostStopping === true || input.stopPressed === true ? 'stopping' : 'working'
}
