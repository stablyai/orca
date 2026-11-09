import type { AppState } from '@/store/types'
import { lastVerifiedRuntimeStatus } from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { AgentLaunchRoutingInput } from '@/lib/agent-session/launch/routing/agent-launch-routing'
import { parseWslUncPath } from '../../../../shared/wsl-paths'
import { parseExecutionHostId } from '../../../../shared/execution-host'

export function agentPickerUsesNativeRuntime(
  route: AgentLaunchRoutingInput,
  platform: NodeJS.Platform | undefined,
  cwd: string
): boolean {
  if (
    route.projectExecutionKind === 'ssh' ||
    parseWslUncPath(cwd) ||
    route.projectRuntime?.status === 'repair-required'
  ) {
    return false
  }
  if (route.projectRuntime?.status === 'resolved') {
    return route.projectRuntime.runtime.kind !== 'wsl'
  }
  // Paired Windows projects choose their runtime on the server, outside the client's route facts.
  return !(
    parseExecutionHostId(route.executionHostId)?.kind === 'runtime' &&
    route.workspaceKind !== 'floating' &&
    (!platform || platform === 'win32')
  )
}

export function agentPickerCliReadOptions(
  target: RuntimeClientTarget,
  worktreeId: string | undefined,
  worktreePath: string,
  route: AgentLaunchRoutingInput,
  generation: readonly unknown[]
) {
  return {
    cliRuntime:
      route.projectExecutionKind !== 'ssh' && route.projectRuntime?.status !== 'repair-required',
    invocationKey:
      target.kind === 'local' && !worktreeId && !worktreePath
        ? undefined
        : JSON.stringify([...generation, route.projectRuntime, worktreePath]),
    cliContext: { target, worktreeId, worktreePath }
  }
}

export function agentPickerHostPlatform(
  target: RuntimeClientTarget | null | undefined,
  statuses: AppState['runtimeStatusByEnvironmentId']
) {
  return target?.kind === 'environment'
    ? lastVerifiedRuntimeStatus(statuses.get(target.environmentId))?.hostPlatform
    : getRendererAppPlatform()
}

export function agentPickerCatalogAvailability(
  target: RuntimeClientTarget | null | undefined,
  route: AgentLaunchRoutingInput,
  workspaceId: string | undefined,
  nativeRuntime: boolean
) {
  return {
    structured: !!target && nativeRuntime,
    cli:
      !!target &&
      route.projectExecutionKind !== 'ssh' &&
      route.projectRuntime?.status !== 'repair-required' &&
      (target.kind === 'local' || !!workspaceId)
  }
}
