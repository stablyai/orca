import { useAppStore } from '@/store/index'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/workspace/ownership/worktree-runtime-owner'
import {
  getRuntimeTargetHostId,
  runtimeTargetForOwnerEnvironment
} from '@/runtime/rpc/targets/runtime-client-target'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

/** Simulators run where the workspace's runtime runs, as the browser pane's pages do. */
export function emulatorRuntimeTarget(worktreeId: string | null | undefined): RuntimeClientTarget {
  return runtimeTargetForOwnerEnvironment(
    runtimeEnvironmentIdOrLocalUnlessTwin(useAppStore.getState(), worktreeId)
  )
}

export function emulatorExecutionHostId(worktreeId: string): ExecutionHostId {
  return getRuntimeTargetHostId(emulatorRuntimeTarget(worktreeId))
}
