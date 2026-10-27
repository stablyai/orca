import type { AppState } from '@/store/types'
import type { TaskProviderConnections } from '../../../shared/task-providers'

// Why: the last settled check decides visibility; the status checks themselves already follow the focused runtime.
export function selectTaskProviderConnections(state: AppState): TaskProviderConnections {
  const preflightSettled =
    state.preflightStatusChecked && !state.preflightStatusLoading && !state.preflightStatusError
  const gh = state.preflightStatus?.gh
  const glab = state.preflightStatus?.glab
  return {
    ...(preflightSettled
      ? {
          github: gh?.installed === true && gh.authenticated === true,
          gitlab: glab?.installed === true && glab.authenticated === true
        }
      : {}),
    ...(state.linearStatusChecked ? { linear: state.linearStatus.connected === true } : {}),
    ...(state.jiraStatusChecked ? { jira: state.jiraStatus.connected === true } : {})
  }
}
