import { useEffect, useMemo } from 'react'
import { getLocalPreflightContext } from '@/runtime/hosts/preflight/local-preflight-context'
import { localPreflightContextKey } from '@/runtime/hosts/preflight/local-preflight-context-key'
import { getEnvironmentRuntimeContextKey } from '@/runtime/hosts/observations/provider-runtime-context'
import { defaultScopeHost } from '@/runtime/hosts/selection/default-creation-host'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { useAppStore } from '@/store/index'

/** Refreshes provider statuses for the host that owns new projects and returns that owner. */
export function useIntegrationProviderStatusRefresh(): RuntimeClientTarget {
  const settings = useAppStore((s) => s.settings)
  const preflightStatusChecked = useAppStore((s) => s.preflightStatusChecked)
  const preflightStatusContextKey = useAppStore((s) => s.preflightStatusContextKey)
  const linearStatusChecked = useAppStore((s) => s.linearStatusChecked)
  const linearStatusContextKey = useAppStore((s) => s.linearStatusContextKey)
  const jiraStatusChecked = useAppStore((s) => s.jiraStatusChecked)
  const jiraStatusContextKey = useAppStore((s) => s.jiraStatusContextKey)
  const clickupStatusChecked = useAppStore((s) => s.clickupStatusChecked)
  const clickupStatusContextKey = useAppStore((s) => s.clickupStatusContextKey)
  const checkLinearConnection = useAppStore((s) => s.checkLinearConnection)
  const checkJiraConnection = useAppStore((s) => s.checkJiraConnection)
  const checkClickUpConnection = useAppStore((s) => s.checkClickUpConnection)
  const refreshPreflightStatus = useAppStore((s) => s.refreshPreflightStatus)
  const expectedPreflightContextKey = useAppStore((s) =>
    localPreflightContextKey(getLocalPreflightContext(s))
  )
  const providerOwner = useMemo(() => defaultScopeHost(settings), [settings])
  const providerRuntimeContextKey = getEnvironmentRuntimeContextKey(
    runtimeTargetEnvironmentId(providerOwner)
  )
  const preflightStatusCurrent = preflightStatusContextKey === expectedPreflightContextKey
  const linearStatusCurrent = linearStatusContextKey === providerRuntimeContextKey
  const jiraStatusCurrent = jiraStatusContextKey === providerRuntimeContextKey
  const clickupStatusCurrent = clickupStatusContextKey === providerRuntimeContextKey

  useEffect(() => {
    if (!linearStatusCurrent || !linearStatusChecked) {
      void checkLinearConnection()
    }
    if (!jiraStatusCurrent || !jiraStatusChecked) {
      void checkJiraConnection()
    }
    if (!clickupStatusCurrent || !clickupStatusChecked) {
      void checkClickUpConnection(providerOwner)
    }
    if (!preflightStatusCurrent || !preflightStatusChecked) {
      void refreshPreflightStatus()
    }
  }, [
    checkClickUpConnection,
    checkJiraConnection,
    checkLinearConnection,
    jiraStatusChecked,
    jiraStatusCurrent,
    jiraStatusContextKey,
    clickupStatusChecked,
    clickupStatusCurrent,
    clickupStatusContextKey,
    linearStatusChecked,
    linearStatusCurrent,
    linearStatusContextKey,
    expectedPreflightContextKey,
    preflightStatusChecked,
    preflightStatusContextKey,
    preflightStatusCurrent,
    providerOwner,
    providerRuntimeContextKey,
    refreshPreflightStatus
  ])

  return providerOwner
}
