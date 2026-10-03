/** Step 4 enables this only after the credential writers have been removed. */
export function claudeProfileRoutingEnabled(): boolean {
  return false
}

export const CLAUDE_PROFILE_ROUTING_CAPABILITY = 'claude.profile-routing.v1'
export const CLAUDE_PROFILE_POINTER_ENV = 'ORCA_CLAUDE_PROFILE_POINTER'
/** The one spelling of the guest pointer location, relative to the guest's $HOME. */
export const WSL_CLAUDE_PROFILE_POINTER_FROM_HOME = '.local/share/orca/claude-profiles/selected-wsl'
/** What WSL panes carry; only the posix and fish claude functions expand it. */
export const WSL_CLAUDE_PROFILE_POINTER = `~/${WSL_CLAUDE_PROFILE_POINTER_FROM_HOME}`
/** Twin of the CLAUDE_CONFIG_DIR Orca injected at spawn; any other value was exported by the user. */
export const CLAUDE_INJECTED_CONFIG_DIR_ENV = 'ORCA_CLAUDE_INJECTED_CONFIG_DIR'

export function requireClaudeProfileRoutingCapability(capabilities: readonly string[]): void {
  if (!capabilities.includes(CLAUDE_PROFILE_ROUTING_CAPABILITY)) {
    throw new Error('This host does not support Claude profiles. Update the execution host.')
  }
}
