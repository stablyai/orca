import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { GIT_COMMIT_ACTIONS_CAPABILITY } from '../../../../../shared/source-control/runtime/git-graph-capabilities'
import { useStructuredAgentSessionHostCapabilityState } from '../../native-chat/host-capabilities/structured-agent-session-host-capability'
import {
  ensureLocalRuntimeCapabilities,
  readLocalRuntimeCapabilitiesOrUnknown
} from '../../hosts/capabilities/local-runtime-capabilities'
import { runtimeEnvironmentSupportsCapability } from '../../rpc/compatibility/runtime-capability-proof'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'

export async function gitCommitActionsSupported(target: RuntimeClientTarget): Promise<boolean> {
  if (target.kind === 'environment') {
    return runtimeEnvironmentSupportsCapability(target.environmentId, GIT_COMMIT_ACTIONS_CAPABILITY)
  }
  await ensureLocalRuntimeCapabilities()
  return readLocalRuntimeCapabilitiesOrUnknown()?.includes(GIT_COMMIT_ACTIONS_CAPABILITY) === true
}

export function useGitCommitActionsSupport(target: RuntimeClientTarget | null, hostName?: string) {
  const t = useTranslate()
  const state = useStructuredAgentSessionHostCapabilityState(target, GIT_COMMIT_ACTIONS_CAPABILITY)
  const environmentName = useAppStore((store) =>
    target?.kind === 'environment'
      ? store.runtimeEnvironments.find((environment) => environment.id === target.environmentId)
          ?.name
      : undefined
  )
  return {
    supported: state === 'supported',
    reason:
      state === 'unsupported'
        ? t('gitGraph.updateActionsHost', 'Update Orca on {{host}} to act on commits', {
            host:
              environmentName ??
              (hostName === 'local' ? undefined : hostName) ??
              t('gitGraph.thisHost', 'this host')
          })
        : undefined
  }
}
