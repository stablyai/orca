import { codexCliInstallation } from '../../../shared/codex-cli-installation'
import {
  CODEX_MAINTENANCE_CAPABILITY,
  CodexMaintenanceStateSchema,
  type CodexMaintenanceParams,
  type CodexMaintenanceState
} from '../../../shared/codex-cli-maintenance'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'

export type CodexMaintenanceTarget = RuntimeClientTarget & { cwd?: string }

export function codexMaintenanceTargetKey(target: CodexMaintenanceTarget): string {
  const host =
    target.kind === 'environment' ? `runtime:${target.environmentId}:codex` : 'local:codex'
  return target.cwd ? `${host}:${JSON.stringify(target.cwd)}` : host
}

export async function callCodexMaintenance(
  target: CodexMaintenanceTarget,
  params: CodexMaintenanceParams
): Promise<CodexMaintenanceState> {
  params = { ...params, ...(target.cwd ? { cwd: target.cwd } : {}) }
  if (target.kind === 'environment') {
    const supported = await runtimeEnvironmentSupportsCapability(
      target.environmentId,
      CODEX_MAINTENANCE_CAPABILITY
    )
    if (!supported) {
      if (params.operation === 'start') {
        throw new Error('Execution host does not support Codex maintenance.')
      }
      return {
        installation: codexCliInstallation(true, null),
        canRun: false,
        job: null
      }
    }
    return CodexMaintenanceStateSchema.parse(
      await callRuntimeRpc(target, 'preflight.codexMaintenance', params)
    )
  }
  return CodexMaintenanceStateSchema.parse(await window.api.preflight.codexMaintenance(params))
}
