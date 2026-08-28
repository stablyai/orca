import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { LinearIssue } from '../../../shared/linear/issue-types'
import type { LinearProjectDetail } from '../../../shared/linear/project-types'
import type {
  LinearCollectionResult,
  LinearConnectionStatus,
  LinearViewer,
  LinearWorkspaceSelection
} from '../../../shared/linear/workspace-types'
import {
  callRuntimeRpc,
  getActiveRuntimeTarget,
  runtimeEnvironmentSupportsCapability
} from './runtime-rpc-client'
import {
  getTaskSourceRuntimeSettings,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import { isRuntimeProviderSearchQueryWithinLimit } from './runtime-provider-search-bounds'
import type { LinearIssueAttributeFilter } from '../../../shared/linear/issue-attribute-filter'
import {
  canonicalizeLinearIssueAttributeFilter,
  isEmptyLinearIssueAttributeFilter
} from '../../../shared/linear/issue-attribute-filter'
import { LINEAR_ISSUE_ATTRIBUTE_FILTER_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'

export type RuntimeLinearSettings =
  | Pick<GlobalSettings, 'activeRuntimeEnvironmentId'>
  | TaskSourceContext
  | null
  | undefined

// Why: mixed-version remotes must not look like an empty filtered result. The
// Linear store swallows most read failures; this typed error is rethrown so UI
// can show an upgrade message instead of "no matching issues".
export class LinearIssueAttributeFilterUnsupportedError extends Error {
  constructor(message = 'This remote runtime must be updated to filter Linear issues.') {
    super(message)
    this.name = 'LinearIssueAttributeFilterUnsupportedError'
  }
}

export function isLinearIssueAttributeFilterUnsupportedError(
  error: unknown
): error is LinearIssueAttributeFilterUnsupportedError {
  return error instanceof LinearIssueAttributeFilterUnsupportedError
}

export type LinearIssueFilter = 'assigned' | 'created' | 'all' | 'completed'
export type LinearConnectResult = { ok: true; viewer: LinearViewer } | { ok: false; error: string }
export type LinearCreateIssueResult =
  | { ok: true; id: string; identifier: string; title: string; url: string }
  | { ok: false; error: string }
export type LinearCreateProjectResult =
  | { ok: true; project: LinearProjectDetail }
  | { ok: false; error: string }
export type LinearMutationResult = { ok: true } | { ok: false; error: string }
export type LinearCommentResult = { ok: true; id: string } | { ok: false; error: string }
export type LinearReadOptions = { force?: boolean }

export function linearReadForce(options?: LinearReadOptions): { force: true } | {} {
  return options?.force ? { force: true } : {}
}

function isTaskSourceRuntimeSettings(
  settings: RuntimeLinearSettings
): settings is TaskSourceContext {
  return settings !== null && settings !== undefined && 'kind' in settings
}

export function getLinearRuntimeTarget(
  settings: RuntimeLinearSettings
): ReturnType<typeof getActiveRuntimeTarget> {
  // Why: task source context makes provider ownership explicit; legacy callers
  // still pass focused runtime settings until Tasks finishes migrating.
  return getActiveRuntimeTarget(
    isTaskSourceRuntimeSettings(settings) ? getTaskSourceRuntimeSettings(settings) : settings
  )
}

function normalizeLinearIssueCollectionResult(
  result: unknown
): LinearCollectionResult<LinearIssue> {
  if (Array.isArray(result)) {
    return { items: result as LinearIssue[] }
  }
  if (!result || typeof result !== 'object') {
    return { items: [] }
  }
  const collection = result as Partial<LinearCollectionResult<LinearIssue>>
  if (!Array.isArray(collection.items)) {
    return { items: [] }
  }
  return {
    items: collection.items,
    ...(Array.isArray(collection.errors) ? { errors: collection.errors } : {}),
    ...(typeof collection.hasMore === 'boolean' ? { hasMore: collection.hasMore } : {})
  }
}

export async function linearStatus(
  settings: RuntimeLinearSettings
): Promise<LinearConnectionStatus> {
  const target = getLinearRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearConnectionStatus>(target, 'linear.status', undefined, {
        timeoutMs: 15_000
      })
    : window.api.linear.status()
}

export async function linearTestConnection(
  settings: RuntimeLinearSettings,
  workspaceId?: string | null
): Promise<LinearConnectResult> {
  const target = getLinearRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearConnectResult>(
        target,
        'linear.testConnection',
        workspaceId ? { workspaceId } : undefined,
        {
          timeoutMs: 30_000
        }
      )
    : window.api.linear.testConnection(workspaceId ? { workspaceId } : undefined)
}

export async function linearConnect(
  settings: RuntimeLinearSettings,
  apiKey: string
): Promise<LinearConnectResult> {
  const target = getLinearRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearConnectResult>(
        target,
        'linear.connect',
        { apiKey },
        { timeoutMs: 30_000 }
      )
    : window.api.linear.connect({ apiKey })
}

export async function linearDisconnect(settings: RuntimeLinearSettings): Promise<void> {
  return linearDisconnectWorkspace(settings)
}

export async function linearDisconnectWorkspace(
  settings: RuntimeLinearSettings,
  workspaceId?: string | null
): Promise<void> {
  const target = getLinearRuntimeTarget(settings)
  if (target.kind === 'environment') {
    await callRuntimeRpc<{ ok: true }>(
      target,
      'linear.disconnect',
      workspaceId ? { workspaceId } : undefined,
      {
        timeoutMs: 15_000
      }
    )
    return
  }
  await window.api.linear.disconnect(workspaceId ? { workspaceId } : undefined)
}

export async function linearSelectWorkspace(
  settings: RuntimeLinearSettings,
  workspaceId: LinearWorkspaceSelection
): Promise<LinearConnectionStatus> {
  const target = getLinearRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearConnectionStatus>(
        target,
        'linear.selectWorkspace',
        { workspaceId },
        { timeoutMs: 15_000 }
      )
    : window.api.linear.selectWorkspace({ workspaceId })
}

export async function linearSearchIssues(
  settings: RuntimeLinearSettings,
  query: string,
  limit?: number,
  workspaceId?: LinearWorkspaceSelection | null
): Promise<LinearIssue[]> {
  if (!isRuntimeProviderSearchQueryWithinLimit(query)) {
    return []
  }
  const target = getLinearRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<LinearIssue[]>(
        target,
        'linear.searchIssues',
        { query, limit, workspaceId: workspaceId ?? undefined },
        { timeoutMs: 30_000 }
      )
    : window.api.linear.searchIssues({ query, limit, workspaceId: workspaceId ?? undefined })
}

export async function linearListIssues(
  settings: RuntimeLinearSettings,
  filter?: LinearIssueFilter,
  limit?: number,
  workspaceId?: LinearWorkspaceSelection | null,
  attributeFilter?: LinearIssueAttributeFilter | null
): Promise<LinearCollectionResult<LinearIssue>> {
  const target = getLinearRuntimeTarget(settings)
  const canonicalAttributeFilter =
    attributeFilter && !isEmptyLinearIssueAttributeFilter(attributeFilter)
      ? canonicalizeLinearIssueAttributeFilter(attributeFilter)
      : undefined
  const payload = {
    filter,
    limit,
    workspaceId: workspaceId ?? undefined,
    ...(canonicalAttributeFilter ? { attributeFilter: canonicalAttributeFilter } : {})
  }
  if (
    target.kind === 'environment' &&
    canonicalAttributeFilter &&
    !(await runtimeEnvironmentSupportsCapability(
      target.environmentId,
      LINEAR_ISSUE_ATTRIBUTE_FILTER_RUNTIME_CAPABILITY,
      30_000
    ))
  ) {
    // Why: older runtimes silently strip unknown RPC params; rejecting here
    // prevents their unfiltered rows from being presented or cached as filtered.
    throw new LinearIssueAttributeFilterUnsupportedError()
  }
  const result =
    target.kind === 'environment'
      ? await callRuntimeRpc<unknown>(target, 'linear.listIssues', payload, {
          timeoutMs: 30_000
        })
      : await window.api.linear.listIssues(payload)
  return normalizeLinearIssueCollectionResult(result)
}
