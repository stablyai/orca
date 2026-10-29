/** The consumer retains complete current approval/question records independently of paged history. */
export const AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY =
  'agent-session.current-requests.v1' as const

export const AGENT_SESSION_CURRENT_REQUESTS_V2 = 'agent-session.current-requests.v2' as const
export type CurrentRequestsContract =
  | typeof AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY
  | typeof AGENT_SESSION_CURRENT_REQUESTS_V2
