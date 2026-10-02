import { useEffect } from 'react'
import { getLocalPreflightContext, localPreflightContextKey } from '@/lib/local-preflight-context'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { useAppStore } from '@/store'

export function useIntegrationProviderStatusRefresh(): void {
  const settings = useAppStore((s) => s.settings)
  const preflightStatusChecked = useAppStore((s) => s.preflightStatusChecked)
  const preflightStatusContextKey = useAppStore((s) => s.preflightStatusContextKey)
  const linearStatusChecked = useAppStore((s) => s.linearStatusChecked)
  const linearStatusContextKey = useAppStore((s) => s.linearStatusContextKey)
  const jiraStatusChecked = useAppStore((s) => s.jiraStatusChecked)
  const jiraStatusContextKey = useAppStore((s) => s.jiraStatusContextKey)
  const todoistStatusChecked = useAppStore((s) => s.todoistStatusChecked)
  const todoistStatusContextKey = useAppStore((s) => s.todoistStatusContextKey)
  const checkTodoistConnection = useAppStore((s) => s.checkTodoistConnection)
  const checkLinearConnection = useAppStore((s) => s.checkLinearConnection)
  const checkJiraConnection = useAppStore((s) => s.checkJiraConnection)
  const refreshPreflightStatus = useAppStore((s) => s.refreshPreflightStatus)
  const expectedPreflightContextKey = useAppStore((s) =>
    localPreflightContextKey(getLocalPreflightContext(s))
  )
  const providerRuntimeContextKey = getProviderRuntimeContextKey(settings)
  const preflightStatusCurrent = preflightStatusContextKey === expectedPreflightContextKey
  const linearStatusCurrent = linearStatusContextKey === providerRuntimeContextKey
  const jiraStatusCurrent = jiraStatusContextKey === providerRuntimeContextKey
  const todoistStatusCurrent = todoistStatusContextKey === providerRuntimeContextKey

  useEffect(() => {
    if (!linearStatusCurrent || !linearStatusChecked) {
      void checkLinearConnection()
    }
    if (!jiraStatusCurrent || !jiraStatusChecked) {
      void checkJiraConnection()
    }
    if (!todoistStatusCurrent || !todoistStatusChecked) {
      void checkTodoistConnection()
    }
    if (!preflightStatusCurrent || !preflightStatusChecked) {
      void refreshPreflightStatus()
    }
  }, [
    checkJiraConnection,
    checkLinearConnection,
    jiraStatusChecked,
    jiraStatusCurrent,
    jiraStatusContextKey,
    linearStatusChecked,
    linearStatusCurrent,
    linearStatusContextKey,
    expectedPreflightContextKey,
    preflightStatusChecked,
    preflightStatusContextKey,
    preflightStatusCurrent,
    providerRuntimeContextKey,
    refreshPreflightStatus,
    checkTodoistConnection,
    todoistStatusChecked,
    todoistStatusCurrent
  ])
}
