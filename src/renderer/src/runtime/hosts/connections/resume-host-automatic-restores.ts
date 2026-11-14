import { RUNTIME_AUTOMATIC_WORK_RUNTIME_CAPABILITY } from '../../../../../shared/host-runtime-capabilities'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import { runtimeEnvironmentSupportsCapability } from '../../rpc/compatibility/runtime-capability-proof'
import { runtimeTargetForOwnerEnvironment } from '../../rpc/targets/runtime-client-target'

/** Whether the host that owns a pane can clear a recorded pause; this app always can. */
export async function canResumeHostAutomaticRestores(
  environmentId: string | null
): Promise<boolean> {
  if (!environmentId) {
    return true
  }
  try {
    return await runtimeEnvironmentSupportsCapability(
      environmentId,
      RUNTIME_AUTOMATIC_WORK_RUNTIME_CAPABILITY
    )
  } catch {
    return false
  }
}

/** Clears the host's automatic-restore pause; sleeping panes still resume one by one. */
export async function resumeHostAutomaticRestores(environmentId: string | null): Promise<void> {
  await callRuntimeRpc(
    runtimeTargetForOwnerEnvironment(environmentId),
    'runtime.automaticWork.resume'
  )
}
