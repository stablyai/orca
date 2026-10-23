import { translate } from '@/i18n/i18n'
import type { AppState } from '@/store/types'
import { resolveHostCapabilities } from './agent-launch-route-input'
import { resolveOwner } from './resolve-owner'
import { authorityKey, hostAuthorityFromOperationRoute } from '../../../shared/host-authority'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { AGENT_SESSION_CLAUDE_CHECKED_RESUME_RUNTIME_CAPABILITY } from '../../../shared/agent-session-resume-runtime-capabilities'

export function claudeResumeHostSupportsCheckedRestore(
  state: AppState,
  worktreeId: string,
  transportRoute?: { executionHostId: string | null; runtimeEnvironmentId: string | null }
): boolean {
  const owner = resolveOwner(state, { workspaceId: worktreeId })
  if (owner.kind !== 'resolved') {
    return false
  }
  const authority = transportRoute ? hostAuthorityFromOperationRoute(transportRoute) : owner.owner
  if (!authority || authority === 'contradictory' || authority.at !== 'local') {
    return false
  }
  if (authorityKey(authority) !== authorityKey(owner.owner)) {
    return false
  }
  const endpointHostId =
    authority.endpoint.kind === 'environment'
      ? toRuntimeExecutionHostId(authority.endpoint.environmentId)
      : 'local'
  return (
    resolveHostCapabilities(state, endpointHostId)?.includes(
      AGENT_SESSION_CLAUDE_CHECKED_RESUME_RUNTIME_CAPABILITY
    ) === true
  )
}

export function claudeCheckedResumeUnavailableMessage(): string {
  return translate(
    'auto.lib.resume.claude.checked.host.required',
    'Update the execution host before restoring this Claude session, or resume it manually with its original account. The recovery record has been kept.'
  )
}
