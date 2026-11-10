// Share Stop display policy across rows/chat/composer so host progress and local presses cannot disagree.

export type AgentStopDisplayStatus = 'stopping' | 'working' | 'not-working'

/** Show stopping only while working and either the host is ending a user Stop or this client's Stop request is in flight. */
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
