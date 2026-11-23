import { useEffect } from 'react'
import { getLocalPreflightContext } from '@/runtime/hosts/preflight/local-preflight-context'
import { localPreflightContextKey } from '@/runtime/hosts/preflight/local-preflight-context-key'
import { getProviderRuntimeContextKey } from '@/runtime/hosts/observations/provider-runtime-context'
import { useAppStore } from '@/store/index'

export function useIntegrationProviderStatusRefresh(): void {
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
  const providerRuntimeContextKey = getProviderRuntimeContextKey(settings)
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
      void checkClickUpConnection()
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
    providerRuntimeContextKey,
    refreshPreflightStatus
  ])
}
