import { useEffect } from 'react'
import { useAppStore } from '@/store/index'
import {
  readRuntimeStatuses,
  appRuntimeStatusSubscriptions
} from '@/store/slices/runtime-status/views/runtime-status-owner'
import {
  ALL_EXECUTION_HOSTS_SCOPE,
  LOCAL_EXECUTION_HOST_ID,
  parseRoutableExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostScope
} from '../../../../../../shared/execution-host/execution-host'
import { lastVerifiedRuntimeStatus } from '../../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { loadHostStructuredAgents } from '@/runtime/native-chat/agent-catalogs/host-structured-agents'
import {
  ensureLocalRuntimeCapabilities,
  subscribeLocalRuntimeCapabilitiesKnown
} from '@/runtime/hosts/capabilities/local-runtime-capabilities'

/** Resume eligibility needs the recording host's catalog even when new agents default to terminals. */
export function useAiVaultResumeCatalogs(scope: ExecutionHostScope): void {
  // oxlint-disable-next-line react-doctor/effect-needs-cleanup -- Cleanup disposes both conditional subscriptions and blocks pending capability delivery.
  useEffect(() => {
    let disposed = false
    const host = parseRoutableExecutionHostId(scope)
    const all = scope === ALL_EXECUTION_HOSTS_SCOPE
    const local = all || host?.kind === 'local'
    const loadLocal = (capabilities: readonly string[] | null): void => {
      if (!disposed) {
        void loadHostStructuredAgents(LOCAL_EXECUTION_HOST_ID, capabilities, null)
      }
    }
    const stopLocal = local ? subscribeLocalRuntimeCapabilitiesKnown(loadLocal) : undefined
    if (local) {
      void ensureLocalRuntimeCapabilities().then(loadLocal)
    }
    const loadRuntime = (environmentId: string): void => {
      const status = lastVerifiedRuntimeStatus(readRuntimeStatuses().get(environmentId))
      if (!disposed && status) {
        void loadHostStructuredAgents(
          toRuntimeExecutionHostId(environmentId),
          status.capabilities,
          status.runtimeId
        )
      }
    }
    let seenEnvironments = useAppStore.getState().runtimeEnvironments
    let seenStatuses = readRuntimeStatuses()
    const loadChangedRuntimes = (): void => {
      const environments = useAppStore.getState().runtimeEnvironments
      const statuses = readRuntimeStatuses()
      const previousEnvironments = seenEnvironments
      const previousStatuses = seenStatuses
      seenEnvironments = environments
      seenStatuses = statuses
      if (all) {
        if (environments === previousEnvironments && statuses === previousStatuses) {
          return
        }
        const previousIds =
          environments !== previousEnvironments
            ? new Set(previousEnvironments.map((environment) => environment.id))
            : undefined
        for (const environment of environments) {
          if (
            (previousIds && !previousIds.has(environment.id)) ||
            statuses.get(environment.id) !== previousStatuses.get(environment.id)
          ) {
            loadRuntime(environment.id)
          }
        }
      } else if (
        host?.kind === 'runtime' &&
        statuses.get(host.environmentId) !== previousStatuses.get(host.environmentId)
      ) {
        loadRuntime(host.environmentId)
      }
    }
    // One store wake per publication; the reference gate inside skips unchanged inputs.
    const stopChanges =
      all || host?.kind === 'runtime'
        ? appRuntimeStatusSubscriptions().subscribeStore(loadChangedRuntimes)
        : undefined
    if (all) {
      for (const environment of seenEnvironments) {
        loadRuntime(environment.id)
      }
    } else if (host?.kind === 'runtime') {
      loadRuntime(host.environmentId)
    }
    return () => {
      disposed = true
      stopLocal?.()
      stopChanges?.()
    }
  }, [scope])
}
