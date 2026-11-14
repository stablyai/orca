import { useAppStore } from '@/store/index'
import { HOST_MODEL_CATALOG_ACCOUNT_SETTINGS } from '../../../../../shared/agent-session/options/model-catalog/host-model-catalog-snapshot-rules'
import { structuralValuesEqual } from '../../../../../shared/structural-value-equality'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId
} from '../../../../../shared/execution-host'
import { lastVerifiedRuntimeStatus } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { subscribeRuntimeHostContactRegained } from '../../hosts/connections/runtime-host-contact-regained'
import {
  readLocalRuntimeCapabilitiesOrUnknown,
  subscribeLocalRuntimeCapabilitiesKnown
} from '../../hosts/capabilities/local-runtime-capabilities'
import {
  readHostStructuredAgentsForRuntime,
  subscribeHostStructuredAgents
} from '../agent-catalogs/host-structured-agents'
import { runtimeEnvironmentContinuityStamp } from '../../rpc/environment-revisions/runtime-environment-revision'

export function modelMenuRequestContext(target: RuntimeClientTarget): string {
  const state = useAppStore.getState()
  const status =
    target.kind === 'environment'
      ? state.runtimeStatusByEnvironmentId.get(target.environmentId)
      : undefined
  return JSON.stringify(
    target.kind === 'local'
      ? HOST_MODEL_CATALOG_ACCOUNT_SETTINGS.map((key) => state.settings?.[key])
      : [
          runtimeEnvironmentContinuityStamp(target.environmentId),
          status?.hostContactEpoch,
          status?.connectionGeneration,
          lastVerifiedRuntimeStatus(status)?.runtimeId
        ]
  )
}

/** Events only; subscriptions live with committed consumers or outstanding requests. */
export function subscribeModelMenuInvalidation(
  target: RuntimeClientTarget,
  invalidate: () => void
) {
  const registered = () =>
    readHostStructuredAgentsForRuntime(
      target.kind === 'local'
        ? LOCAL_EXECUTION_HOST_ID
        : toRuntimeExecutionHostId(target.environmentId),
      target.kind === 'local'
        ? null
        : lastVerifiedRuntimeStatus(
            useAppStore.getState().runtimeStatusByEnvironmentId.get(target.environmentId)
          )?.runtimeId
    )
  let agents = registered()
  const stopAgents = subscribeHostStructuredAgents(() => {
    const next = registered()
    if (next !== agents) {
      agents = next
      invalidate()
    }
  })
  let capabilities = readLocalRuntimeCapabilitiesOrUnknown()
  const stopHost =
    target.kind === 'local'
      ? subscribeLocalRuntimeCapabilitiesKnown((next) => {
          if (!structuralValuesEqual(next, capabilities)) {
            capabilities = next
            invalidate()
          }
        })
      : subscribeRuntimeHostContactRegained(target.environmentId, invalidate)
  let settings = useAppStore.getState().settings
  const stopStore = useAppStore.subscribe((state) => {
    const previous = settings
    settings = state.settings
    if (
      target.kind === 'local' &&
      HOST_MODEL_CATALOG_ACCOUNT_SETTINGS.some(
        (key) => !structuralValuesEqual(state.settings?.[key], previous?.[key])
      )
    ) {
      invalidate()
    }
  })
  return () => {
    stopAgents()
    stopHost()
    stopStore()
  }
}
