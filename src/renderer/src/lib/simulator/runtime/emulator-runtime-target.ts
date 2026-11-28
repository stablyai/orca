import { useAppStore } from '@/store/index'
import { translate } from '@/i18n/i18n'
import {
  runtimeEnvironmentIdForWorkspaceOwner,
  runtimeEnvironmentIdUnlessTwin
} from '@/lib/workspace/ownership/resolve-owner'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { toRuntimeExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/rpc/targets/runtime-client-target'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

/** Simulators run on the host that owns the workspace. A twin is refused, never read as this app,
 *  so a paired server's workspace can't boot this desktop's simulators. */
export function emulatorRuntimeTarget(worktreeId: string): RuntimeClientTarget {
  const owner = runtimeEnvironmentIdForWorkspaceOwner(useAppStore.getState(), {
    workspaceId: worktreeId
  })
  if (owner.kind !== 'resolved') {
    throw new Error(
      translate(
        'auto.lib.simulator.runtime.emulatorRuntimeTarget.ambiguousOwner',
        "Couldn't tell which computer runs this workspace. Reopen it and try again."
      )
    )
  }
  return runtimeTargetForOwnerEnvironment(owner.environmentId)
}

/** The paired server that runs the workspace's simulators, by name; null for this computer. */
export function emulatorServerLabel(worktreeId: string): string | null {
  const state = useAppStore.getState()
  const environmentId = runtimeEnvironmentIdUnlessTwin(state, worktreeId)
  return environmentId
    ? selectExecutionHostDisplayLabel(state, toRuntimeExecutionHostId(environmentId))
    : null
}
