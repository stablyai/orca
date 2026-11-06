import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { GIT_COMMIT_ACTIONS_CAPABILITY } from '../../../shared/source-control/runtime/git-graph-capabilities'
import { useStructuredAgentSessionHostCapabilityState } from './structured-agent-session-host-capability'
import {
  ensureLocalRuntimeCapabilities,
  readLocalRuntimeCapabilitiesOrUnknown
} from './local-runtime-capabilities'
import { runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'

export async function gitCommitActionsSupported(target: RuntimeClientTarget): Promise<boolean> {
  if (target.kind === 'environment') {
    return runtimeEnvironmentSupportsCapability(target.environmentId, GIT_COMMIT_ACTIONS_CAPABILITY)
  }
  await ensureLocalRuntimeCapabilities()
  return readLocalRuntimeCapabilitiesOrUnknown()?.includes(GIT_COMMIT_ACTIONS_CAPABILITY) === true
}

export function useGitCommitActionsSupport(target: RuntimeClientTarget | null, hostName?: string) {
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
        ? translate('gitGraph.updateActionsHost', 'Update Orca on {{host}} to act on commits', {
            host:
              environmentName ??
              (hostName === 'local' ? undefined : hostName) ??
              translate('gitGraph.thisHost', 'this host')
          })
        : undefined
  }
}
