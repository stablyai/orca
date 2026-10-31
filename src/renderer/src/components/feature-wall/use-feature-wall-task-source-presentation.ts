import { useEffect } from 'react'
import type { FeatureWallWorkflow } from '../../../../shared/feature-wall-workflows'
import { useAppStore } from '@/store'
import { getLocalPreflightContext, localPreflightContextKey } from '@/lib/local-preflight-context'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { deriveIntegrationConnectionStatus } from './use-integration-connection-status'

export type FeatureWallTaskSourcePresentation = {
  workflow: FeatureWallWorkflow
  hasConnectedTaskSource: boolean
  // Hide disconnected setup until provider checks settle to prevent flashes for connected users.
  isCheckingTaskSources: boolean
}

export function useFeatureWallTaskSourcePresentation(
  isOpen: boolean,
  selected: FeatureWallWorkflow
): FeatureWallTaskSourcePresentation {
  const preflightStatus = useAppStore((s) => s.preflightStatus)
  const preflightStatusChecked = useAppStore((s) => s.preflightStatusChecked)
  const preflightStatusContextKey = useAppStore((s) => s.preflightStatusContextKey)
  const preflightStatusError = useAppStore((s) => s.preflightStatusError)
  const preflightStatusLoading = useAppStore((s) => s.preflightStatusLoading)
  const refreshPreflightStatus = useAppStore((s) => s.refreshPreflightStatus)
  const linearStatus = useAppStore((s) => s.linearStatus)
  const linearStatusChecked = useAppStore((s) => s.linearStatusChecked)
  const linearStatusContextKey = useAppStore((s) => s.linearStatusContextKey)
  const checkLinearConnection = useAppStore((s) => s.checkLinearConnection)
  const jiraStatus = useAppStore((s) => s.jiraStatus)
  const jiraStatusChecked = useAppStore((s) => s.jiraStatusChecked)
  const jiraStatusContextKey = useAppStore((s) => s.jiraStatusContextKey)
  const checkJiraConnection = useAppStore((s) => s.checkJiraConnection)
  const settings = useAppStore((s) => s.settings)
  const expectedPreflightContextKey = useAppStore((s) =>
    localPreflightContextKey(getLocalPreflightContext(s))
  )
  const providerRuntimeContextKey = getProviderRuntimeContextKey(settings)
  const linearStatusCurrent = linearStatusContextKey === providerRuntimeContextKey
  const jiraStatusCurrent = jiraStatusContextKey === providerRuntimeContextKey
  const preflightStatusCurrent = preflightStatusContextKey === expectedPreflightContextKey

  useEffect(() => {
    if (!isOpen) {
      return
    }
    // Refresh connection facts before choosing setup-oriented tour copy.
    if (!preflightStatusCurrent || !preflightStatusChecked) {
      void refreshPreflightStatus()
    }
    if (!linearStatusCurrent || !linearStatusChecked) {
      void checkLinearConnection()
    }
    if (!jiraStatusCurrent || !jiraStatusChecked) {
      void checkJiraConnection()
    }
  }, [
    checkJiraConnection,
    checkLinearConnection,
    expectedPreflightContextKey,
    isOpen,
    jiraStatusCurrent,
    jiraStatusChecked,
    jiraStatusContextKey,
    linearStatusCurrent,
    linearStatusChecked,
    linearStatusContextKey,
    preflightStatusContextKey,
    preflightStatusCurrent,
    preflightStatusChecked,
    providerRuntimeContextKey,
    refreshPreflightStatus
  ])

  const taskSourceStatus = deriveIntegrationConnectionStatus({
    preflightStatus,
    preflightStatusChecked,
    preflightStatusContextKey,
    preflightStatusError,
    preflightStatusLoading,
    expectedPreflightContextKey,
    linearStatus,
    linearStatusChecked,
    linearStatusContextKey,
    jiraStatus,
    jiraStatusChecked,
    jiraStatusContextKey,
    providerRuntimeContextKey
  })

  return {
    workflow: selected,
    hasConnectedTaskSource: taskSourceStatus.trackerConnected,
    isCheckingTaskSources: taskSourceStatus.checking
  }
}
