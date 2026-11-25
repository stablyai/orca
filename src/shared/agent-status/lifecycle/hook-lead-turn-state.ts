import type { AgentStatusIpcPayload } from '../contracts/agent-status-ipc-payload'

export type HookTurnState = 'done' | 'working' | 'permission'

/** Read the lead's own turn: child completion cannot end it, but child permission waits still block. An ended lead can accept input while children run. */
export function hookLeadTurnState(
  row: Pick<AgentStatusIpcPayload, 'state' | 'mainAgent' | 'sessionBoundary'>
): HookTurnState | null {
  // Why no answer: a session start is not a turn end, and some agents post it before their
  // composer accepts input, so startup readiness stays with the screen and text rules.
  if (row.state === 'done' && row.sessionBoundary === true) {
    return null
  }
  if (row.state === 'waiting' || row.state === 'blocked') {
    return 'permission'
  }
  const lead = row.mainAgent?.state ?? row.state
  return lead === 'done' || lead === 'working' ? lead : 'permission'
}
