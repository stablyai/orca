// Why: older hosts reject a settings.update containing repositoryAddScript; clients must check
// this before writing it.
export const REPOSITORY_ADD_SCRIPT_RUNTIME_CAPABILITY = 'repository.add-script.v1' as const

export const REPOSITORY_ADD_SCRIPT_RUNTIME_CAPABILITIES = [
  REPOSITORY_ADD_SCRIPT_RUNTIME_CAPABILITY
] as const
