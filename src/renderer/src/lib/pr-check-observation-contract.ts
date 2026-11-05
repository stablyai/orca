import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import { RUNTIME_CONNECTION_CHANGED_MESSAGE } from '../web/web-runtime-request-registry'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { AppState } from '../store/types'
import { GITHUB_COMPLETE_PR_CHECK_OBSERVATION_CAPABILITY } from '../../../shared/source-control/runtime/source-control-runtime-capabilities'
import { lastVerifiedRuntimeStatus } from '../../../shared/remote-runtime/host-status/runtime-host-status'
import { readLocalRuntimeCapabilitiesOrUnknown } from '../runtime/local-runtime-capabilities'
import { getRuntimeEnvironmentRevision } from '../runtime/runtime-environment-revision'
import { getRuntimeEnvironmentConnectionGeneration } from '../store/slices/runtime-status-connection-generation'

export function capturePRCheckContract(
  get: () => AppState,
  target: RuntimeClientTarget,
  source?: TaskSourceContext | null
) {
  const read = () => {
    if (target.kind === 'local') {
      return {
        runtimeId: undefined,
        epoch: 'local',
        complete:
          readLocalRuntimeCapabilitiesOrUnknown()?.includes(
            GITHUB_COMPLETE_PR_CHECK_OBSERVATION_CAPABILITY
          ) === true
      }
    }
    const entry = get().runtimeStatusByEnvironmentId?.get(target.environmentId)
    const status = lastVerifiedRuntimeStatus(entry)
    return {
      runtimeId: status?.runtimeId,
      epoch: `${getRuntimeEnvironmentRevision(target.environmentId)}:${getRuntimeEnvironmentConnectionGeneration(target.environmentId)}:${status?.runtimeId ?? ''}`,
      complete:
        status?.capabilities?.includes(GITHUB_COMPLETE_PR_CHECK_OBSERVATION_CAPABILITY) === true
    }
  }
  const captured = read()
  const current = () => {
    const now = read()
    return now.epoch === captured.epoch && now.complete === captured.complete
  }
  return {
    scope: `${source ? getTaskSourceCacheScope(source) : 'workspace'}:${target.kind === 'local' ? 'local' : target.environmentId}:${captured.epoch}`,
    complete: captured.complete,
    current,
    rpcOptions:
      target.kind === 'environment'
        ? {
            expectedEnvironmentPairingRevision: getRuntimeEnvironmentRevision(target.environmentId),
            expectedEnvironmentRuntimeId: captured.runtimeId,
            beforeSend: () => {
              if (!current()) {
                throw new Error(RUNTIME_CONNECTION_CHANGED_MESSAGE)
              }
            }
          }
        : {}
  }
}

export type PRCheckContract = ReturnType<typeof capturePRCheckContract>
