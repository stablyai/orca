// Older hosts ignore workspace params and probe their own PATH; never treat that as workspace evidence (e.g. WSL on Windows).
export const PREFLIGHT_WORKSPACE_SCOPED_RUNTIME_CAPABILITY =
  'preflight.workspace-scoped.v1' as const
// This host refuses foreign-runtime workspaces with WORKSPACE_ON_OTHER_RUNTIME instead of returning its own agents.
export const PREFLIGHT_OTHER_RUNTIME_REFUSAL_RUNTIME_CAPABILITY =
  'preflight.other-runtime-refusal.v1' as const
export const PREFLIGHT_PROJECT_LAUNCH_CONTEXT_RUNTIME_CAPABILITY =
  'preflight.project-launch-context.v1' as const
/** What such a host answers, instead of probing itself, for another runtime's workspace. */
export const WORKSPACE_ON_OTHER_RUNTIME = 'workspace_on_other_runtime'
export const PREFLIGHT_HOST_QUALIFIED_RUNTIME_CAPABILITY = 'preflight.host-qualified.v1' as const

export const PREFLIGHT_RUNTIME_CAPABILITIES = [
  PREFLIGHT_WORKSPACE_SCOPED_RUNTIME_CAPABILITY,
  PREFLIGHT_PROJECT_LAUNCH_CONTEXT_RUNTIME_CAPABILITY,
  PREFLIGHT_OTHER_RUNTIME_REFUSAL_RUNTIME_CAPABILITY,
  PREFLIGHT_HOST_QUALIFIED_RUNTIME_CAPABILITY
] as const
