// Older hosts drop automation.list's selector and return every host's rows.
export const AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY =
  'automation.list-host-scope.v1' as const
export const AUTOMATION_LIST_HOST_SCOPE_UPDATE_REQUIRED_MESSAGE =
  'Filtering automations by host requires a newer Orca server. Update the HUB and try again.'
// Owner preconditions prevent mutations against a host the user never saw.
export const AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY = 'automation.owner-fencing.v1' as const
export const AUTOMATION_OWNER_FENCING_UPDATE_REQUIRED_MESSAGE =
  'Editing automations on this host requires a newer Orca server. Update the HUB and try again.'
export const AUTOMATION_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY =
  'automation.create-idempotency.v1' as const
// Older hosts strip extraAgentArgs and would run without the user's arguments.
export const AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY =
  'automations.extra-agent-args.v1' as const

export const AUTOMATION_RUNTIME_CAPABILITIES = [
  AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY,
  AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY,
  AUTOMATION_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY,
  AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY
] as const

export const AUTOMATION_RUNTIME_CLIENT_CAPABILITIES = [
  AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY,
  AUTOMATION_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY
] as const
