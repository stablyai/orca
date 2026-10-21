// Why: older hosts discard preflight.detectAgents params and probe their own PATH, so a client
// must not read that answer as the workspace's (a WSL project on a Windows host differs).
export const PREFLIGHT_WORKSPACE_SCOPED_RUNTIME_CAPABILITY =
  'preflight.workspace-scoped.v1' as const
// Why: an older host answers its own agents for a workspace another runtime owns; one with this
// refuses with WORKSPACE_ON_OTHER_RUNTIME, so a client may let it decide for a shared repo id.
export const PREFLIGHT_OTHER_RUNTIME_REFUSAL_RUNTIME_CAPABILITY =
  'preflight.other-runtime-refusal.v1' as const
/** What such a host answers, instead of probing itself, for another runtime's workspace. */
export const WORKSPACE_ON_OTHER_RUNTIME = 'workspace_on_other_runtime'

export const PREFLIGHT_RUNTIME_CAPABILITIES = [
  PREFLIGHT_WORKSPACE_SCOPED_RUNTIME_CAPABILITY,
  PREFLIGHT_OTHER_RUNTIME_REFUSAL_RUNTIME_CAPABILITY
] as const
