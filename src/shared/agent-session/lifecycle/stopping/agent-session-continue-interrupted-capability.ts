// Offer Continue only when the host advertises it; older hosts also lack the row identifying an Orca stop.
export const AGENT_SESSION_CONTINUE_INTERRUPTED_RUNTIME_CAPABILITY =
  'agent-session.continue-interrupted.v1' as const
// Why: hosts before this advertise continue-interrupted.v1 but refuse the method from a phone.
export const AGENT_SESSION_PHONE_CONTINUE_INTERRUPTED_RUNTIME_CAPABILITY =
  'agent-session.continue-interrupted.phone.v1' as const
