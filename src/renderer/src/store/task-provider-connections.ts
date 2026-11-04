import type { AppState } from '@/store/types'
import {
  getLocalPreflightContext,
  getLocalPreflightTarget,
  localPreflightContextKey
} from '@/lib/local-preflight-context'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { getTaskPageRepoSourceContext } from '@/lib/task-repo-source-context'
import { taskSourceRuntimeTarget } from '@/lib/task-source-runtime-target'
import { isGitRepoKind } from '../../../shared/repo-kind'
import type { Repo } from '../../../shared/repo-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { TaskProviderConnections } from '../../../shared/task-providers'

function isSameRuntimeTarget(left: RuntimeClientTarget, right: RuntimeClientTarget): boolean {
  return left.kind === 'environment'
    ? right.kind === 'environment' && left.environmentId === right.environmentId
    : right.kind === 'local'
}

/** Whether every repo routes its forge reads through the runtime whose CLIs preflight checked. */
function reposShareRuntime(repos: readonly Repo[], target: RuntimeClientTarget): boolean {
  return repos.every((repo) =>
    isSameRuntimeTarget(
      taskSourceRuntimeTarget(getTaskPageRepoSourceContext(repo, 'github')),
      target
    )
  )
}

// Why: a check from another runtime, project or WSL context is pending here, not a verdict.
// Pass the task repos in view; omitted, every git repo counts since any may be selected.
export function selectTaskProviderConnections(
  state: AppState,
  repos: readonly Repo[] = state.repos.filter(isGitRepoKind)
): TaskProviderConnections {
  const providerRuntimeContextKey = getProviderRuntimeContextKey(state.settings)
  const preflightSettled =
    state.preflightStatusContextKey === localPreflightContextKey(getLocalPreflightContext(state)) &&
    state.preflightStatusChecked &&
    !state.preflightStatusLoading &&
    !state.preflightStatusError &&
    // Why: gh/glab sign-in on one runtime says nothing about repos owned by another runtime.
    reposShareRuntime(repos, getLocalPreflightTarget(state))
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
