/** Step 4 enables this only after the credential writers have been removed. */
export function claudeProfileRoutingEnabled(): boolean {
  return false
}

export const CLAUDE_PROFILE_ROUTING_CAPABILITY = 'claude.profile-routing.v1'
export const CLAUDE_PROFILE_POINTER_ENV = 'ORCA_CLAUDE_PROFILE_POINTER'
/** Twin of the CLAUDE_CONFIG_DIR Orca injected at spawn; any other value was exported by the user. */
export const CLAUDE_INJECTED_CONFIG_DIR_ENV = 'ORCA_CLAUDE_INJECTED_CONFIG_DIR'

export function requireClaudeProfileRoutingCapability(capabilities: readonly string[]): void {
  if (!capabilities.includes(CLAUDE_PROFILE_ROUTING_CAPABILITY)) {
    throw new Error('This host does not support Claude profiles. Update the execution host.')
  }
}
