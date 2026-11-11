import { recomputeOn } from '@/lib/recompute-on'
import type { ComponentProps } from 'react'
import { AgentLaunchChoiceEditor } from '@/components/agent/launch-settings/AgentLaunchChoiceEditor'
import type { AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import { useAppStateValue, useAppViewExternalStore } from '@/store/retained-views/app-state-view'
import { useHostStructuredAgentsVersion } from '@/runtime/native-chat/agent-catalogs/chat-provider-agents'
import { readHostStructuredAgentsForRuntime } from '@/runtime/native-chat/agent-catalogs/host-structured-agents'
import {
  readLocalRuntimeCapabilityObservation,
  subscribeLocalRuntimeCapabilityObservation
} from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId
} from '../../../../../../shared/execution-host'
import { lastVerifiedRuntimeStatus } from '../../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { AGENT_SESSION_COHERENT_MODEL_CATALOG_CAPABILITY } from '../../../../../../shared/agent-session/structured-agent-session-surface-capabilities'
import { modelMenuUsesHostCatalog } from '../../../../../../shared/agent-session/options/model-menu-source'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'

export function HostAgentLaunchChoiceEditor({
  detectionTarget,
  commandOverride,
  ...props
}: ComponentProps<typeof AgentLaunchChoiceEditor> & {
  detectionTarget: AgentDetectionTarget
  commandOverride?: string
}) {
  const version = useHostStructuredAgentsVersion()
  const localCapabilities = useAppViewExternalStore(
    subscribeLocalRuntimeCapabilityObservation,
    readLocalRuntimeCapabilityObservation,
    readLocalRuntimeCapabilityObservation
  )
  const status = useAppStateValue((state) =>
    detectionTarget.kind === 'runtime'
      ? state.runtimeStatusByEnvironmentId.get(detectionTarget.environmentId)
      : undefined
  )
  const host =
    detectionTarget.kind === 'runtime'
      ? toRuntimeExecutionHostId(detectionTarget.environmentId)
      : LOCAL_EXECUTION_HOST_ID
  const agents = recomputeOn([version, host, status], () =>
    readHostStructuredAgentsForRuntime(
      host,
      detectionTarget.kind === 'runtime' ? lastVerifiedRuntimeStatus(status)?.runtimeId : null
    )
  )
  const registered = agents ? agents.some(({ agent }) => agent === props.agent) : true
  const capabilities =
    detectionTarget.kind === 'runtime'
      ? lastVerifiedRuntimeStatus(status)?.capabilities
      : localCapabilities.state === 'known'
        ? localCapabilities.capabilities
        : null
  const eligible = modelMenuUsesHostCatalog({
    nativeRuntime: detectionTarget.kind !== 'ssh',
    registered,
    commandOverride,
    serverCommandOverride: commandOverride,
    paired: detectionTarget.kind === 'runtime',
    platform:
      detectionTarget.kind === 'runtime'
        ? lastVerifiedRuntimeStatus(status)?.hostPlatform
        : window.api.platform.get().platform
  })
  const target: RuntimeClientTarget =
    detectionTarget.kind === 'runtime'
      ? { kind: 'environment', environmentId: detectionTarget.environmentId }
      : { kind: 'local' }
  return (
    <AgentLaunchChoiceEditor
      {...props}
      catalogSource={
        eligible && props.agent !== 'antigravity'
          ? {
              scope: { target, agent: props.agent },
              coherentCatalog:
                capabilities?.includes(AGENT_SESSION_COHERENT_MODEL_CATALOG_CAPABILITY) === true
            }
          : undefined
      }
    />
  )
}
