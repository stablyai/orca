/** Agents whose sign-in a host can check and relay; matches HostAccountSignInProvider. */
export type HostAgentSignInAgent = 'claude' | 'codex'

export const HOST_AGENT_SIGN_IN_AGENTS: readonly HostAgentSignInAgent[] = ['claude', 'codex']

export type HostAgentSignInState = 'signedIn' | 'signedOut' | 'notInstalled' | 'unknown'

/** How a signed-in agent authenticates; never the credential itself. */
export type HostAgentSignInMethod = 'orcaAccount' | 'cliLogin' | 'apiKey'

export type HostAgentSignInEntry = {
  agent: HostAgentSignInAgent
  state: HostAgentSignInState
  method?: HostAgentSignInMethod
}

/** What a host reports about its agents' sign-in. Carries verdicts only, never tokens or CLI output. */
export type HostAgentSignInReport = {
  checkedAt: number
  agents: HostAgentSignInEntry[]
}
