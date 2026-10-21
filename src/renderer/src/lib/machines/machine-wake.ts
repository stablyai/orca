import type {
  MachineActionResult,
  MachineRecord,
  MachineTarget
} from '../../../../shared/machine-inventory'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { applyEnvironmentMachineResult } from '@/store/machines'

/**
 * The one way the UI wakes a machine. Concurrent wakes of one machine are joined by the main
 * process that runs its provider (this app's, or a paired server's), so callers just ask.
 */
export async function wakeMachine(
  target: MachineTarget,
  options: { environmentId?: string | null; operationId?: string } = {}
): Promise<MachineActionResult<MachineRecord>> {
  const environmentId = options.environmentId ?? null
  if (environmentId === null) {
    return window.api.machines.wake({
      ...target,
      ...(options.operationId ? { operationId: options.operationId } : {})
    })
  }
  // Why: a paired server's provider wakes its own machine; this app only asks.
  const result = await callRuntimeRpc<MachineActionResult<MachineRecord>>(
    { kind: 'environment', environmentId },
    'machines.wake',
    target
  )
  // Why: nothing pushes a paired server's changes here, so take the returned record now.
  applyEnvironmentMachineResult(environmentId, result)
  return result
}
