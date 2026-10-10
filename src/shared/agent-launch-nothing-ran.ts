// A failed `agent.launch` the host proves ran nothing: no agent spawned for it and none will, so the
// caller may start the agent another way without doubling it. Rides as optional error data beside
// the unchanged code, so a peer that never reads it sees the same failure as before.
export const AGENT_LAUNCH_NOTHING_RAN_DATA = { agentLaunchNothingRan: true } as const

export function isAgentLaunchNothingRanData(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    'agentLaunchNothingRan' in data &&
    data.agentLaunchNothingRan === true
  )
}
