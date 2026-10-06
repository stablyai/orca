import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import type { StructuredAgentSessionResumeSource } from '../../../shared/structured-agent-session-create'
import type { AgentLaunchProfile } from '../../../shared/agent-launch-profile'

// An account rebind is a different launch; a rename alone can safely join the pending launch.
export function structuredLaunchIdentity(
  worktreeId: string,
  agent: AgentSessionHandleProvider,
  resumeFrom?: StructuredAgentSessionResumeSource,
  agentProfile?: AgentLaunchProfile
): string {
  if (agentProfile) {
    return JSON.stringify([
      agent,
      worktreeId,
      resumeFrom?.providerSessionId ?? null,
      agentProfile.id,
      agentProfile.hostId,
      agentProfile.binding
    ])
  }
  return resumeFrom
    ? `${agent}:${worktreeId}:resume:${resumeFrom.providerSessionId}`
    : `${agent}:${worktreeId}`
}
