import { useAppStore } from '@/store'
import { getActiveRuntimeTarget, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import {
  resolveWorktreeOperationRouteResultForHost,
  settingsForWorktreeOperationRoute
} from '@/lib/worktree-operation-route'
import { parseExecutionHostId } from '../../../../shared/execution-host'

export function resolveTarget(scope: string): RuntimeClientTarget | null {
  let descriptor: unknown
  try {
    descriptor = JSON.parse(scope)
  } catch {
    return null
  }
  if (
    !Array.isArray(descriptor) ||
    descriptor[0] !== 'workspace-tab' ||
    typeof descriptor[2] !== 'string'
  ) {
    return null
  }
  const host = parseExecutionHostId(descriptor[1])
  if (!host) {
    return null
  }
  const state = useAppStore.getState()
  const route = resolveWorktreeOperationRouteResultForHost(state, descriptor[2], host.id)
  return route.kind === 'resolved'
    ? getActiveRuntimeTarget(settingsForWorktreeOperationRoute(state.settings, route.route))
    : null
}
