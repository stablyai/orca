// A failed `agent.launch` request the host proves ran nothing: no agent spawned for it and none will.
// On an operation's first send that covers the whole launch, so the caller may start the agent
// another way without doubling it; after a replay an earlier send may have run, as with
// `classifyAgentLaunchReplayRefusal`. Rides as optional error data beside the unchanged code, so a
// peer that never reads it sees the same failure as before.
export const AGENT_LAUNCH_NOTHING_RAN_DATA = { agentLaunchNothingRan: true } as const

export function isAgentLaunchNothingRanData(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    'agentLaunchNothingRan' in data &&
    data.agentLaunchNothingRan === true
  )
}
