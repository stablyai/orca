import type { MaestroActor, MaestroWorkspaceAnchor } from './maestro-contract'

export type MaestroPrincipal = MaestroActor & {
  workspace: Pick<MaestroWorkspaceAnchor, 'execution_host_id' | 'workspace_key' | 'run_id'>
  generation?: number
}

export function canRequestMaestroIntent(
  principal: MaestroPrincipal,
  workspace: MaestroWorkspaceAnchor
): boolean {
  if (
    principal.workspace.execution_host_id !== workspace.execution_host_id ||
    principal.workspace.workspace_key !== workspace.workspace_key ||
    principal.workspace.run_id !== workspace.run_id
  ) {
    return false
  }
  return (
    principal.kind === 'user' || principal.kind === 'worker' || principal.kind === 'coordinator'
  )
}

export function canConsumeMaestroIntent(
  principal: MaestroPrincipal,
  workspace: MaestroWorkspaceAnchor,
  generation: number
): boolean {
  return (
    principal.kind === 'coordinator' &&
    principal.workspace.run_id === workspace.run_id &&
    principal.workspace.execution_host_id === workspace.execution_host_id &&
    principal.workspace.workspace_key === workspace.workspace_key &&
    principal.generation === generation
  )
}
