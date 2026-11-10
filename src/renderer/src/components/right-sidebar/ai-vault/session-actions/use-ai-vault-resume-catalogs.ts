import { useEffect } from 'react'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import {
  ALL_EXECUTION_HOSTS_SCOPE,
  LOCAL_EXECUTION_HOST_ID,
  parseRoutableExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostScope
} from '../../../../../../shared/execution-host'
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
      const status = lastVerifiedRuntimeStatus(
        useAppStore.getState().runtimeStatusByEnvironmentId.get(environmentId)
      )
      if (!disposed && status) {
        void loadHostStructuredAgents(
          toRuntimeExecutionHostId(environmentId),
          status.capabilities,
          status.runtimeId
        )
      }
    }
    const loadRuntimes = (previous?: AppState): void => {
      if (all) {
        const state = useAppStore.getState()
        const previousIds =
          previous && state.runtimeEnvironments !== previous.runtimeEnvironments
            ? new Set(previous.runtimeEnvironments.map((environment) => environment.id))
            : undefined
        for (const environment of state.runtimeEnvironments) {
          if (
            !previous ||
            (previousIds && !previousIds.has(environment.id)) ||
            state.runtimeStatusByEnvironmentId.get(environment.id) !==
              previous.runtimeStatusByEnvironmentId.get(environment.id)
          ) {
            loadRuntime(environment.id)
          }
        }
      } else if (host?.kind === 'runtime') {
        loadRuntime(host.environmentId)
      }
    }
    const stopStore =
      all || host?.kind === 'runtime'
        ? useAppStore.subscribe((state, previous) => {
            const changed = all
              ? state.runtimeEnvironments !== previous.runtimeEnvironments ||
                state.runtimeStatusByEnvironmentId !== previous.runtimeStatusByEnvironmentId
              : host?.kind === 'runtime' &&
                state.runtimeStatusByEnvironmentId.get(host.environmentId) !==
                  previous.runtimeStatusByEnvironmentId.get(host.environmentId)
            if (changed) {
              loadRuntimes(previous)
            }
          })
        : undefined
    loadRuntimes()
    return () => {
      disposed = true
      stopLocal?.()
      stopStore?.()
    }
  }, [scope])
}
