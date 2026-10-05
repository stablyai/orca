import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { resolveLocalAccountRuntimeTarget } from '../../../shared/local-account-runtime'
import { getActiveRuntimeTarget, runtimeTargetForExecutionHostId } from './runtime-client-target'

export function getDeepSeekAccountScope(
  settings: GlobalSettings | null,
  executionHostId: ExecutionHostId | null,
  platform: NodeJS.Platform
): { environmentId: string | null; unsupported: boolean } {
  const target = executionHostId
    ? runtimeTargetForExecutionHostId(executionHostId)
    : getActiveRuntimeTarget(settings)
  if (!target) {
    return { environmentId: null, unsupported: true }
  }
  if (target.kind === 'environment') {
    return { environmentId: target.environmentId, unsupported: false }
  }
  return {
    environmentId: null,
    unsupported:
      settings !== null && resolveLocalAccountRuntimeTarget(settings, platform).runtime === 'wsl'
  }
}
