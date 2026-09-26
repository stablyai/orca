import type { PluginHostListEntry } from '../../../preload/api-types'
import type {
  PluginPanelEntry,
  PluginPanelActionOutcome
} from '../../../shared/plugins/plugin-panel-bridge'
import { callRuntimeRpc } from './runtime-rpc-client'
import { getActiveRuntimeTarget } from './runtime-client-target'
import type { WorktreeOperationRouteState } from '@/lib/worktree-operation-route'
import { resolveWorktreeOperationRouteResult } from '@/lib/worktree-operation-route'

/** undefined means ownership is unresolved, never permission to execute locally. */
export function pluginRuntimeOwner(state: WorktreeOperationRouteState): string | null | undefined {
  if (!state.activeWorktreeId) {
    const target = getActiveRuntimeTarget(state.settings)
    return target.kind === 'environment' ? target.environmentId : null
  }
  const resolution = resolveWorktreeOperationRouteResult(state, state.activeWorktreeId)
  return resolution.kind === 'resolved' ? resolution.route.runtimeEnvironmentId : undefined
}

export function listRuntimePlugins(environmentId: string): Promise<PluginHostListEntry[]> {
  return callRuntimeRpc({ kind: 'environment', environmentId }, 'plugins.list')
}

export function readRuntimePluginPanel(
  environmentId: string,
  pluginKey: string,
  panelId: string
): Promise<PluginPanelEntry | null> {
  return callRuntimeRpc({ kind: 'environment', environmentId }, 'plugins.readPanelEntry', {
    pluginKey,
    panelId
  })
}

export function invokeRuntimePluginCommand(
  environmentId: string,
  pluginKey: string,
  commandId: string
): Promise<unknown> {
  return callRuntimeRpc({ kind: 'environment', environmentId }, 'plugins.invokeCommand', {
    pluginKey,
    commandId
  })
}

export async function runtimePluginPanelAction(
  environmentId: string,
  args: {
    sessionToken: string
    action: string
    params?: unknown
  }
): Promise<PluginPanelActionOutcome> {
  const result = await callRuntimeRpc<{ outcome: PluginPanelActionOutcome }>(
    { kind: 'environment', environmentId },
    'plugins.panelAction',
    args
  )
  return result.outcome
}
