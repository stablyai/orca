import type { GlobalSettings } from '../../../shared/global-settings-types'
import { isRuntimeOwnedSshTargetId, parseExecutionHostId } from '../../../shared/execution-host'
import {
  getOrcadSshDeployment,
  type PublicKnownRuntimeEnvironment
} from '../../../shared/runtime-environments'

type SshBrowserRoutingSettings = Pick<
  GlobalSettings,
  'browserSshWorkspaceRoutingEnabled' | 'browserSshWorkspaceRoutingDisabledTargetIds'
>

export type SshWorkspaceBrowserRouteEligibility = {
  targetId: string
  eligible: boolean
  expectedSshTargetGeneration?: number
}

export function resolveSshWorkspaceBrowserRouteEligibility(
  executionHostId: string | null | undefined,
  settings: SshBrowserRoutingSettings | null | undefined,
  environments?: readonly Pick<PublicKnownRuntimeEnvironment, 'id' | 'orcadDeployment'>[]
): SshWorkspaceBrowserRouteEligibility | null {
  const parsed = parseExecutionHostId(executionHostId)
  const environment =
    parsed?.kind === 'runtime'
      ? environments?.find((candidate) => candidate.id === parsed.environmentId)
      : undefined
  // Why a WSL deployment is not an SSH route: its pages egress through the paired runtime's
  // network tunnel over the wsl.exe bridge, never through WSL localhost forwarding.
  const deployment = environment && getOrcadSshDeployment(environment)
  const targetId = parsed?.kind === 'ssh' ? parsed.targetId : deployment?.sshTargetId
  // Why: runtime-owned ephemeral SSH targets belong to the paired runtime's browser route.
  if (!targetId || isRuntimeOwnedSshTargetId(targetId)) {
    return null
  }
  return {
    targetId,
    ...(deployment ? { expectedSshTargetGeneration: deployment.sshTargetGeneration } : {}),
    eligible:
      settings?.browserSshWorkspaceRoutingEnabled !== false &&
      !settings?.browserSshWorkspaceRoutingDisabledTargetIds?.includes(targetId)
  }
}
