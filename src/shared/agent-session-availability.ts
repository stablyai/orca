import { agentSessionSignInFor } from './agent-session-sign-in'

export type AgentSessionAccountKind = 'managed' | 'system'

/** Host-probed chat/account unavailability; absent older-host/pending verdicts remain unknown and display nothing. */
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

export function agentSessionSignInCopyId(provider: string, account?: AgentSessionAccountKind) {
  const signIn = agentSessionSignInFor(provider)
  return signIn?.agent === 'claude'
    ? account === 'managed'
      ? 'claudeManagedNotSignedIn'
      : 'claudeSystemNotSignedIn'
    : signIn?.agent === 'codex'
      ? account === 'managed'
        ? 'codexManagedNotSignedIn'
        : 'codexSystemNotSignedIn'
      : signIn?.agent === 'antigravity'
        ? 'antigravityNotSignedIn'
        : signIn?.agent === 'pi'
          ? 'interactiveAgentNotSignedIn'
          : signIn?.loginCommand.length
            ? 'agentCommandNotSignedIn'
            : 'agentNotSignedIn'
}
