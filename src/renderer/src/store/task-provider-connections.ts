import type { AppState } from '@/store/types'
import { getLocalPreflightContext, localPreflightContextKey } from '@/lib/local-preflight-context'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import type { TaskProviderConnections } from '../../../shared/task-providers'

// Why: a check from another runtime, project or WSL context is pending here, not a verdict.
export function selectTaskProviderConnections(state: AppState): TaskProviderConnections {
  const providerRuntimeContextKey = getProviderRuntimeContextKey(state.settings)
  const preflightSettled =
    state.preflightStatusContextKey === localPreflightContextKey(getLocalPreflightContext(state)) &&
    state.preflightStatusChecked &&
    !state.preflightStatusLoading &&
    !state.preflightStatusError
  const gh = state.preflightStatus?.gh
  const glab = state.preflightStatus?.glab
  return {
    ...(preflightSettled
      ? {
          github: gh?.installed === true && gh.authenticated === true,
          gitlab: glab?.installed === true && glab.authenticated === true
        }
      : {}),
    ...(state.linearStatusChecked && state.linearStatusContextKey === providerRuntimeContextKey
      ? { linear: state.linearStatus.connected === true }
      : {}),
    ...(state.jiraStatusChecked && state.jiraStatusContextKey === providerRuntimeContextKey
      ? { jira: state.jiraStatus.connected === true }
      : {})
  }
}
