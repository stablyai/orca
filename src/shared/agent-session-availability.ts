export type AgentSessionAccountKind = 'managed' | 'system'

/** Why no chat can start under the account a chat runs with, as the host's catalog probe found it.
 *  Absent (an older host, or no verdict yet) is unknown, which shows nothing. */
export type AgentSessionUnavailable =
  | { reason: 'notSignedIn'; account?: AgentSessionAccountKind }
  | { reason: 'cliMissing' }

/** A reason this build does not know reads as unknown, never as a different reason. */
export function readAgentSessionUnavailable(value: unknown): AgentSessionUnavailable | null {
  if (typeof value !== 'object' || value === null || !('reason' in value)) {
    return null
  }
  if (value.reason === 'cliMissing') {
    return { reason: 'cliMissing' }
  }
  if (value.reason !== 'notSignedIn') {
    return null
  }
  const account = 'account' in value ? value.account : undefined
  return {
    reason: 'notSignedIn',
    ...(account === 'managed' || account === 'system' ? { account } : {})
  }
}

export function agentSessionSignInCopyId(
  provider: 'claude' | 'codex',
  account?: AgentSessionAccountKind
) {
  return provider === 'claude'
    ? account === 'managed'
      ? 'claudeManagedNotSignedIn'
      : 'claudeSystemNotSignedIn'
    : account === 'managed'
      ? 'codexManagedNotSignedIn'
      : 'codexSystemNotSignedIn'
}
