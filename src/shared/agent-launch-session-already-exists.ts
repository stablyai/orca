export const AGENT_LAUNCH_SESSION_ALREADY_EXISTS_CODE =
  'agent_launch_session_already_exists' as const

// The caller-minted chat session id already names a session; the host created nothing.
export class AgentLaunchSessionAlreadyExistsError extends Error {
  constructor() {
    super(AGENT_LAUNCH_SESSION_ALREADY_EXISTS_CODE)
    this.name = 'AgentLaunchSessionAlreadyExistsError'
  }
}
