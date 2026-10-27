export const AGENT_LAUNCH_TARGET_FORBIDDEN_CODE = 'agent_launch_target_forbidden' as const

// The caller may not call the create method this target stands for; refused before admission.
// Not `forbidden`: the replay classifier reads that as an older host and falls back to its old path.
export class AgentLaunchTargetForbiddenError extends Error {
  constructor() {
    super(AGENT_LAUNCH_TARGET_FORBIDDEN_CODE)
    this.name = 'AgentLaunchTargetForbiddenError'
  }
}
