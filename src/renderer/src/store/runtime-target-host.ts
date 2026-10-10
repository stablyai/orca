import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { RuntimeClientTarget } from '../runtime/runtime-rpc-client'

export function getRuntimeTargetHostId(target: RuntimeClientTarget): ExecutionHostId {
  return target.kind === 'environment'
    ? toRuntimeExecutionHostId(target.environmentId)
    : LOCAL_EXECUTION_HOST_ID
}
