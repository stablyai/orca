import type { GlobalSettings } from '../../../shared/global-settings-types'
import { parseExecutionHostId } from '../../../shared/execution-host'

type SshBrowserRoutingSettings = Pick<
  GlobalSettings,
  'browserSshWorkspaceRoutingEnabled' | 'browserSshWorkspaceRoutingDisabledTargetIds'
>

export type SshWorkspaceBrowserRouteEligibility = {
  targetId: string
  eligible: boolean
}

/**
 * Determine whether this desktop may route a workspace browser through SSH.
 * Paired runtimes retain their own transport; desktop targets honor global and per-target opt-outs.
 */
export function resolveSshWorkspaceBrowserRouteEligibility(
  executionHostId: string | null | undefined,
  settings: SshBrowserRoutingSettings | null | undefined,
  runtimeEnvironmentId: string | null
): SshWorkspaceBrowserRouteEligibility | null {
  const parsed = parseExecutionHostId(executionHostId)
  // Why: paired runtimes own their browser transport; desktop recipe targets use local SSH.
  if (parsed?.kind !== 'ssh' || runtimeEnvironmentId !== null) {
    return null
  }
  return {
    targetId: parsed.targetId,
    eligible:
      settings?.browserSshWorkspaceRoutingEnabled !== false &&
      !settings?.browserSshWorkspaceRoutingDisabledTargetIds?.includes(parsed.targetId)
  }
}
