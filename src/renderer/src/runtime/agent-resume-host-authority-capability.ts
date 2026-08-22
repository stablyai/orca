import {
  AGENT_SESSION_KIMI_RESUME_RUNTIME_CAPABILITY,
  AGENT_SESSION_OMP_RESUME_PATH_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../../shared/protocol-version'

// Why: every agent added to RESUMABLE_TUI_AGENTS after agent-session.host-authority.v1 widens the
// host's ensureAgentSession enum. An older host answers the unknown member with invalid_argument,
// which runRemoteAgentSessionLaunch does not treat as a fallback signal, so the pane dies instead
// of degrading to a legacy launch. Probing the agent's own capability keeps version skew safe.
export function agentResumeHostAuthorityCapability(
  agent: string | null | undefined
): RuntimeCapability | undefined {
  if (agent === 'omp') {
    return AGENT_SESSION_OMP_RESUME_PATH_RUNTIME_CAPABILITY
  }
  if (agent === 'kimi') {
    return AGENT_SESSION_KIMI_RESUME_RUNTIME_CAPABILITY
  }
  return undefined
}
