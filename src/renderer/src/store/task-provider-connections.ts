import type { AppState } from '@/store/types'
import { getLocalPreflightContext, localPreflightContextKey } from '@/lib/local-preflight-context'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { deriveIntegrationConnectionStatus } from '@/lib/integration-connection-status'
import type { TaskProviderConnections } from '../../../shared/task-providers'

export function selectTaskProviderConnections(state: AppState): TaskProviderConnections {
  return deriveIntegrationConnectionStatus({
    preflightStatus: state.preflightStatus,
    preflightStatusChecked: state.preflightStatusChecked,
    preflightStatusContextKey: state.preflightStatusContextKey,
    preflightStatusError: state.preflightStatusError,
    preflightStatusLoading: state.preflightStatusLoading,
    expectedPreflightContextKey: localPreflightContextKey(getLocalPreflightContext(state)),
    linearStatus: state.linearStatus,
    linearStatusChecked: state.linearStatusChecked,
    linearStatusContextKey: state.linearStatusContextKey,
    jiraStatus: state.jiraStatus,
    jiraStatusChecked: state.jiraStatusChecked,
    jiraStatusContextKey: state.jiraStatusContextKey,
    providerRuntimeContextKey: getProviderRuntimeContextKey(state.settings)
  }).taskProviderConnections
}
