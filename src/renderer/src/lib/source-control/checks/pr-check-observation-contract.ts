import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../../shared/work-items/task-source-context'
import { RUNTIME_CONNECTION_CHANGED_MESSAGE } from '../../../web/web-runtime-request-registry'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type { AppState } from '../../../store/types'
import type { callRuntimeRpc } from '../../../runtime/rpc/calls/runtime-rpc-call'
import { GITHUB_COMPLETE_PR_CHECK_OBSERVATION_CAPABILITY } from '../../../../../shared/source-control/runtime/source-control-runtime-capabilities'
import { lastVerifiedRuntimeStatus } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { readLocalRuntimeCapabilitiesOrUnknown } from '../../../runtime/hosts/capabilities/local-runtime-capabilities'
import { getRuntimeEnvironmentRevision } from '../../../runtime/rpc/environment-revisions/runtime-environment-revision'
import { getRuntimeEnvironmentConnectionGeneration } from '../../../store/slices/runtime-status/runtime-status-connection-generation'

export function capturePRCheckContract(
  get: () => AppState,
  target: RuntimeClientTarget,
  source?: TaskSourceContext | null
) {
  const read = () => {
    if (target.kind === 'local') {
      return {
        runtimeId: undefined,
        revision: undefined,
        generation: undefined,
        epoch: 'local',
        complete:
          readLocalRuntimeCapabilitiesOrUnknown()?.includes(
            GITHUB_COMPLETE_PR_CHECK_OBSERVATION_CAPABILITY
          ) === true
      }
    }
    const entry = get().runtimeStatusByEnvironmentId?.get(target.environmentId)
    const status = lastVerifiedRuntimeStatus(entry)
    const revision = getRuntimeEnvironmentRevision(target.environmentId)
    const generation = getRuntimeEnvironmentConnectionGeneration(target.environmentId)
    return {
      runtimeId: status?.runtimeId,
      revision,
      generation,
      epoch: `${revision}:${generation}:${status?.runtimeId ?? ''}`,
      complete:
        status?.capabilities?.includes(GITHUB_COMPLETE_PR_CHECK_OBSERVATION_CAPABILITY) === true
    }
  }
  const captured = read()
  const current = () => {
    const now = read()
    return now.epoch === captured.epoch && now.complete === captured.complete
  }
  const sourceCurrent = () => {
    const now = read()
    return (
      now.revision === captured.revision &&
      now.generation === captured.generation &&
      (!captured.runtimeId || now.runtimeId === captured.runtimeId)
    )
  }
  const runtimeOptions =
    target.kind === 'environment'
      ? {
          expectedEnvironmentPairingRevision: captured.revision,
          expectedEnvironmentRuntimeId: captured.runtimeId
        }
      : {}
  const assertCurrent = (valid: () => boolean) => () => {
    if (!valid()) {
      throw new Error(RUNTIME_CONNECTION_CHANGED_MESSAGE)
    }
  }
  const scope = (observation: ReturnType<typeof read>) =>
    `${source ? getTaskSourceCacheScope(source) : 'workspace'}:${target.kind === 'local' ? 'local' : target.environmentId}:${observation.epoch}`
  const optionsFor = (valid: () => boolean): NonNullable<Parameters<typeof callRuntimeRpc>[3]> =>
    target.kind === 'environment' ? { ...runtimeOptions, beforeSend: assertCurrent(valid) } : {}
  return {
    scope: scope(captured),
    complete: captured.complete,
    current,
    sourceCurrent,
    publicationContext: () => {
      const now = read()
      return {
        scope: scope(now),
        complete: captured.complete || now.complete,
        current: sourceCurrent(),
        trusted: captured.complete && current()
      }
    },
    rpcOptions: optionsFor(current),
    sourceRpcOptions: optionsFor(sourceCurrent)
  }
}

export type PRCheckContract = ReturnType<typeof capturePRCheckContract>
