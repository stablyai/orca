import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { getLocalPreflightContext, localPreflightContextKey } from '@/lib/local-preflight-context'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { deriveIntegrationConnectionStatus } from '../feature-wall/use-integration-connection-status'

export type SetupGuideTaskSourceReadiness = {
  hasConnectedTaskSource: boolean
  taskSourceStatusChecking: boolean
}

// Why: extracted from useSetupGuideProgress so that file stays under the
// max-lines ratchet. Refreshes preflight/Linear/Jira/MantisBT status the
// same way use-feature-wall-task-source-presentation does, then derives
// setup-guide readiness from the shared task-source availability logic.
export function useSetupGuideTaskSourceReadiness(
  shouldRefreshCoreState: boolean
): SetupGuideTaskSourceReadiness {
  const settings = useAppStore((s) => s.settings)
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
  const mantisBTStatus = useAppStore((s) => s.mantisBTStatus)
  const mantisBTStatusChecked = useAppStore((s) => s.mantisBTStatusChecked)
  const mantisBTStatusContextKey = useAppStore((s) => s.mantisBTStatusContextKey)
  const checkMantisBTConnection = useAppStore((s) => s.checkMantisBTConnection)
  const expectedPreflightContextKey = useAppStore((s) =>
    localPreflightContextKey(getLocalPreflightContext(s))
  )

  const providerRuntimeContextKey = getProviderRuntimeContextKey(settings)
  const linearStatusCurrent = linearStatusContextKey === providerRuntimeContextKey
  const jiraStatusCurrent = jiraStatusContextKey === providerRuntimeContextKey
  const mantisBTStatusCurrent = mantisBTStatusContextKey === providerRuntimeContextKey
  const preflightStatusCurrent = preflightStatusContextKey === expectedPreflightContextKey

  useEffect(() => {
    if (!shouldRefreshCoreState) {
      return
    }
    if (!preflightStatusCurrent || !preflightStatusChecked) {
      void refreshPreflightStatus()
    }
    if (!linearStatusCurrent || !linearStatusChecked) {
      void checkLinearConnection()
    }
    if (!jiraStatusCurrent || !jiraStatusChecked) {
      void checkJiraConnection()
    }
    if (!mantisBTStatusCurrent || !mantisBTStatusChecked) {
      void checkMantisBTConnection()
    }
  }, [
    checkJiraConnection,
    checkLinearConnection,
    checkMantisBTConnection,
    jiraStatusCurrent,
    jiraStatusChecked,
    jiraStatusContextKey,
    linearStatusCurrent,
    linearStatusChecked,
    linearStatusContextKey,
    mantisBTStatusCurrent,
    mantisBTStatusChecked,
    mantisBTStatusContextKey,
    expectedPreflightContextKey,
    preflightStatusContextKey,
    preflightStatusCurrent,
    preflightStatusChecked,
    providerRuntimeContextKey,
    refreshPreflightStatus,
    shouldRefreshCoreState
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
    mantisBTStatus,
    mantisBTStatusChecked,
    mantisBTStatusContextKey,
    providerRuntimeContextKey
  })

  return {
    hasConnectedTaskSource: taskSourceStatus.trackerConnected,
    taskSourceStatusChecking: taskSourceStatus.checking
  }
}
