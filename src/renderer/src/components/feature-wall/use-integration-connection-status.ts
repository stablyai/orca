import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { selectTaskProviderConnections } from '@/store/task-provider-connections'
import type { TaskProviderConnections } from '../../../../shared/task-providers'
import { getLocalPreflightContext, localPreflightContextKey } from '@/lib/local-preflight-context'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import {
  deriveIntegrationConnectionStatus,
  type IntegrationConnectionStatus
} from '@/lib/integration-connection-status'

export * from '@/lib/integration-connection-status'

export function useTaskProviderConnections(): TaskProviderConnections {
  return useAppStore(useShallow(selectTaskProviderConnections))
}

// Derives the two-step progressive flow's done-state from real provider
// connection status, mirroring use-feature-wall-task-source-presentation so a
// code host counts as both a review source and a task source.
export function useIntegrationConnectionStatus(): IntegrationConnectionStatus {
  const preflightStatus = useAppStore((s) => s.preflightStatus)
  const preflightStatusChecked = useAppStore((s) => s.preflightStatusChecked)
  const preflightStatusContextKey = useAppStore((s) => s.preflightStatusContextKey)
  const preflightStatusError = useAppStore((s) => s.preflightStatusError)
  const preflightStatusLoading = useAppStore((s) => s.preflightStatusLoading)
  const linearStatus = useAppStore((s) => s.linearStatus)
  const linearStatusChecked = useAppStore((s) => s.linearStatusChecked)
  const linearStatusContextKey = useAppStore((s) => s.linearStatusContextKey)
  const jiraStatus = useAppStore((s) => s.jiraStatus)
  const jiraStatusChecked = useAppStore((s) => s.jiraStatusChecked)
  const jiraStatusContextKey = useAppStore((s) => s.jiraStatusContextKey)
  const settings = useAppStore((s) => s.settings)
  const expectedPreflightContextKey = useAppStore((s) =>
    localPreflightContextKey(getLocalPreflightContext(s))
  )

  const providerRuntimeContextKey = getProviderRuntimeContextKey(settings)

  return deriveIntegrationConnectionStatus({
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
}
