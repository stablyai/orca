import type { AgentSessionRefusalReference } from './agent-session-wire-refusals'
import type { AgentSessionFailureSay } from './agent-session-failure-copy'

export function codexInstallationFailureWords(
  refusal: AgentSessionRefusalReference | undefined,
  say: AgentSessionFailureSay
): string | null {
  const installation =
    refusal?.code === 'agent_session_operation_invalid'
      ? refusal.details?.codexInstallation
      : undefined
  return installation
    ? say(installation.installedVersion === null ? 'codexCliMissing' : 'codexCliTooOld', {
        installedVersion: installation.installedVersion ?? '',
        minimumVersion: installation.minimumVersion
      })
    : null
}
