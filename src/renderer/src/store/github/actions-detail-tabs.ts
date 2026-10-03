import { translate } from '@/i18n/i18n'
import { actionsRepoProbeKey } from './actions-request-identity'
import type { AppState } from '../types'
import type {
  ActionsRequestContext,
  ActionsRun,
  ActionsRunDetails
} from '../../../../shared/github/actions-types'
import type { GitHubRepositoryIdentity } from '../../../../shared/github/pull-request-types'
import {
  createCheckRunDetailsRequestId,
  buildCheckRunDetailsTabId
} from '@/components/editor/check-run-details-tab'
import { fetchActionsRunDetails } from './actions-requests'
import { githubRepoIdentityKey } from '../../../../shared/github/repository-identity-key'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'

/** Open a run tab pinned to repository, host and account so later focus changes cannot retarget reads. */
export function openActionsRun(
  state: AppState,
  worktreeId: string,
  context: ActionsRequestContext,
  repository: GitHubRepositoryIdentity,
  run: ActionsRun
): void {
  const repo = state.repos.find((entry) => entry.id === context.repoId)
  if (!repo) {
    return
  }
  const identity = JSON.stringify([
    context.repoId,
    context.repoPath,
    getRepoExecutionHostId(repo),
    githubRepoIdentityKey(repository),
    repo.ghAccount,
    context.sourceContext
  ])
  const check = {
    name: run.displayTitle,
    status: 'queued' as const,
    conclusion: null,
    url: run.htmlUrl,
    workflowRunId: run.id,
    actionsIdentity: identity
  }
  const contextKey = `actions:${identity}:${run.id}`
  state.openCheckRunDetails(worktreeId, contextKey, check, {
    details: null,
    loading: false,
    error: null,
    actionsContext: { ...context, ownerKey: actionsRepoProbeKey(repo) },
    githubRepository: repository
  })
  void state.reloadOpenCheckRunDetailsTab(buildCheckRunDetailsTabId(worktreeId, check))
}

/** Fence refresh generations and append job pages only within the same attempt and repository owner. */
export async function loadActionsDetailTab(
  get: () => AppState,
  fileId: string,
  append = false
): Promise<void> {
  const state = get()
  const file = state.openFiles.find((entry) => entry.id === fileId)
  const current = file?.checkRunDetails
  if (
    !file ||
    !current?.actionsContext ||
    !current.githubRepository ||
    !current.check.workflowRunId
  ) {
    return
  }
  const prior = current.details?.actions ? current.details : null
  if (append && (!prior?.actions?.hasNextPage || current.loading)) {
    return
  }
  const requestId = createCheckRunDetailsRequestId()
  /** Apply detail results with this request ID so a slower generation cannot overwrite a newer tab state. */
  const patch = (
    details: ActionsRunDetails | null,
    loading: boolean,
    error: string | null
  ): void => {
    get().patchOpenCheckRunDetails(file.worktreeId, current.contextKey, current.check, {
      details,
      loading,
      error,
      requestId
    })
  }
  // Why: a refreshed generation owns pagination; a slower page cannot append into it.
  const priorDetails = prior?.actions ? { ...prior, actions: prior.actions } : null
  patch(priorDetails, true, null)
  try {
    const next = await fetchActionsRunDetails(get(), current.actionsContext, {
      repository: current.githubRepository,
      runId: current.check.workflowRunId,
      jobsPage: append && prior?.actions ? prior.actions.jobsPage + 1 : 1,
      expectedAttempt: append ? prior?.actions?.run.runAttempt : undefined,
      noCache: !append
    })
    const latestRepo = get().repos.find((entry) => entry.id === current.actionsContext?.repoId)
    if (
      !latestRepo ||
      (current.actionsContext.ownerKey &&
        current.actionsContext.ownerKey !== actionsRepoProbeKey(latestRepo))
    ) {
      throw new Error(
        translate(
          'actions.ownerChanged',
          'Repository host or account changed. Reopen this run from Actions.'
        )
      )
    }
    if (
      append &&
      next.actions.jobsError &&
      next.actions.run.runAttempt === prior?.actions?.run.runAttempt
    ) {
      patch(priorDetails, false, next.actions.jobsError)
      return
    }
    const details =
      append &&
      prior?.actions &&
      next.actions.run.runAttempt === prior.actions.run.runAttempt &&
      next.actions.jobsPage > 1
        ? {
            ...next,
            jobs: [...prior.jobs, ...next.jobs],
            actions: {
              ...next.actions,
              logWarnings: [...prior.actions.logWarnings, ...next.actions.logWarnings]
            }
          }
        : next
    patch(details, false, null)
  } catch (error) {
    patch(priorDetails, false, error instanceof Error ? error.message : String(error))
  }
}
