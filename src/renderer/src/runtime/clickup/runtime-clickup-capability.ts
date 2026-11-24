import { CLICKUP_RUNTIME_CAPABILITY } from '../../../../shared/clickup/clickup-runtime-capability'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { runtimeEnvironmentSupportsCapability } from '../rpc/compatibility/runtime-capability-proof'

/** Whether the host that owns the ClickUp credential speaks the ClickUp RPCs; this app always does. */
export async function clickupRuntimeSupported(target: RuntimeClientTarget): Promise<boolean> {
  return (
    target.kind !== 'environment' ||
    (await runtimeEnvironmentSupportsCapability(target.environmentId, CLICKUP_RUNTIME_CAPABILITY))
  )
}
