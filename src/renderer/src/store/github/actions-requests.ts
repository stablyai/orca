import { ACTIONS_ARTIFACT_CLIENT_TIMEOUT_MS } from '../../../../shared/github/actions-artifact-types'
import { actionsRepoProbeKey } from './actions-request-identity'
import type { AppState } from '../types'
import type {
  ActionsRequestContext,
  ActionsRunsQuery,
  ActionsWorkflowsQuery,
  ActionsDetailsQuery,
  ActionsPage,
  ActionsRun,
  ActionsWorkflow,
  ActionsRunDetails
} from '../../../../shared/github/actions-types'
import type { GitHubRepositoryIdentity } from '../../../../shared/github/pull-request-types'
import { callRuntimeRpc, RuntimeRpcCallError } from '../../runtime/runtime-rpc-client'
import { getGitHubRepoSourceSettings, getGitHubWorkItemRequestContext } from './work-item-routing'
import { translate } from '@/i18n/i18n'

import type {
  ActionsArtifactsQuery,
  ActionsArtifactDownloadQuery,
  ActionsArtifactTransferQuery
} from '../../../../shared/github/actions-artifact-types'

type ActionsQuery =
  | ActionsRunsQuery
  | ActionsWorkflowsQuery
  | ActionsDetailsQuery
  | ActionsArtifactsQuery
  | ActionsArtifactDownloadQuery
  | ActionsArtifactTransferQuery
  | { requireVerifiedSshProbe: boolean }

const runsInflight = new Map<string, Promise<ActionsPage<ActionsRun>>>()
const workflowsInflight = new Map<string, Promise<ActionsPage<ActionsWorkflow>>>()
const detailsInflight = new Map<string, Promise<ActionsRunDetails>>()
/** Share only identical in-flight reads; bound tracking without canceling evicted requests. */
function shareActionsRequest<T>(
  requests: Map<string, Promise<T>>,
  key: string,
  read: () => Promise<T>
): Promise<T> {
  const existing = requests.get(key)
  if (existing) {
    return existing
  }
  const promise = read().finally(() => {
    if (requests.get(key) === promise) {
      requests.delete(key)
    }
  })
  requests.set(key, promise)
  while (requests.size > 128) {
    const oldest = requests.keys().next().value
    if (oldest !== undefined) {
      requests.delete(oldest)
    }
  }
  return promise
}
/** Include owner, request context, query and dispatch route when identifying shareable reads. */
function actionsRequestKey(
  state: AppState,
  context: ActionsRequestContext,
  args: ActionsQuery
): string {
  const repo = state.repos.find((entry) => entry.id === context.repoId)
  return JSON.stringify([
    repo ? actionsRepoProbeKey(repo) : null,
    context,
    args,
    route(state, context)
  ])
}
/** Validate repository registration and pinned ownership before choosing its account-aware local or runtime route. */
function route(state: AppState, context: ActionsRequestContext) {
  const repo = state.repos.find((entry) => entry.id === context.repoId)
  if (!repo || repo.path !== context.repoPath) {
    throw new Error('Repository is no longer registered')
  }
  if (context.ownerKey && context.ownerKey !== actionsRepoProbeKey(repo)) {
    throw new Error(
      translate(
        'actions.ownerChanged',
        'Repository host or account changed. Reopen this run from Actions.'
      )
    )
  }
  const settings = getGitHubRepoSourceSettings(state.settings, repo, context.sourceContext)
  const target = getGitHubWorkItemRequestContext(
    state,
    settings,
    repo.id,
    repo.path,
    context.sourceContext
  ).target
  return target.kind === 'environment'
    ? { ...target, runtimeRepoId: context.sourceContext?.repoId ?? repo.id }
    : target
}
/** Dispatch to the registered execution owner; report unsupported old hosts without silently falling back locally. */
export async function requestActions<T>(
  state: AppState,
  context: ActionsRequestContext,
  method: string,
  args: ActionsQuery,
  local: () => Promise<T>
): Promise<T> {
  const target = route(state, context)
  try {
    return target.kind === 'environment'
      ? await callRuntimeRpc<T>(
          { kind: 'environment', environmentId: target.environmentId },
          method,
          { repo: target.runtimeRepoId, ...args },
          {
            timeoutMs:
              method === 'github.startActionsArtifactDownload'
                ? ACTIONS_ARTIFACT_CLIENT_TIMEOUT_MS
                : 30_000
          }
        )
      : await local()
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      throw new Error(
        translate(
          'actions.hostUpgrade',
          'This host needs an Orca update to browse Actions. Open Actions on GitHub in the meantime.'
        )
      )
    }
    throw error
  }
}
/** Require a verified SSH origin probe when resolving a registered repository’s GitHub identity. */
export async function fetchActionsRepository(
  state: AppState,
  context: ActionsRequestContext
): Promise<GitHubRepositoryIdentity | null> {
  const args = { requireVerifiedSshProbe: true }
  return requestActions(state, context, 'github.repoSlug', args, () =>
    window.api.gh.repoSlug({ ...context, ...args })
  )
}
/** Share matching in-flight run reads unless an explicit refresh requests fresh data. */
export async function fetchActionsRuns(
  state: AppState,
  context: ActionsRequestContext,
  args: ActionsRunsQuery
): Promise<ActionsPage<ActionsRun>> {
  /** Dispatch this read through the registered repository owner, including its pinned account and host. */
  const read = () =>
    requestActions(state, context, 'github.actionsRuns', args, () =>
      window.api.gh.actionsRuns({ ...context, ...args })
    )
  return args.noCache
    ? read()
    : shareActionsRequest(runsInflight, actionsRequestKey(state, context, args), read)
}
/** Share matching in-flight workflow pages without conflating different hosts, accounts or filters. */
export async function fetchActionsWorkflows(
  state: AppState,
  context: ActionsRequestContext,
  args: ActionsWorkflowsQuery
): Promise<ActionsPage<ActionsWorkflow>> {
  /** Dispatch this read through the registered repository owner, including its pinned account and host. */
  const read = () =>
    requestActions(state, context, 'github.actionsWorkflows', args, () =>
      window.api.gh.actionsWorkflows({ ...context, ...args })
    )
  return args.noCache
    ? read()
    : shareActionsRequest(workflowsInflight, actionsRequestKey(state, context, args), read)
}
/** Share matching attempt/page detail reads while allowing explicit refresh to bypass request sharing. */
export async function fetchActionsRunDetails(
  state: AppState,
  context: ActionsRequestContext,
  args: ActionsDetailsQuery
): Promise<ActionsRunDetails> {
  /** Dispatch this read through the registered repository owner, including its pinned account and host. */
  const read = () =>
    requestActions(state, context, 'github.actionsRunDetails', args, () =>
      window.api.gh.actionsRunDetails({ ...context, ...args })
    )
  return args.noCache
    ? read()
    : shareActionsRequest(detailsInflight, actionsRequestKey(state, context, args), read)
}
