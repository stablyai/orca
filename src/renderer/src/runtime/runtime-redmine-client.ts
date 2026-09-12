import type { GlobalSettings } from '../../../shared/global-settings-types'
import type {
  RedmineConnectionStatus,
  RedmineIssue,
  RedmineIssueCollectionResult,
  RedmineListFilter,
  RedmineReadError,
  RedmineSite,
  RedmineUser
} from '../../../shared/redmine-types'
import { callRuntimeRpc, getActiveRuntimeTarget } from './runtime-rpc-client'
import {
  getTaskSourceRuntimeSettings,
  type TaskSourceContext
} from '../../../shared/task-source-context'

export type RuntimeRedmineSettings =
  | Pick<GlobalSettings, 'activeRuntimeEnvironmentId'>
  | TaskSourceContext
  | null
  | undefined

export type RedmineConnectResult =
  | { ok: true; site: RedmineSite; viewer: RedmineUser }
  | { ok: false; error: { type: string; message: string } }

export type RedmineTestConnectionResult =
  | { ok: true; user: RedmineUser }
  | { ok: false; error: { type: string; message: string } }

export type RedmineReadOptions = { force?: boolean }

export function redmineReadForce(options?: RedmineReadOptions): { force: true } | {} {
  return options?.force ? { force: true } : {}
}

function isTaskSourceRuntimeSettings(
  settings: RuntimeRedmineSettings
): settings is TaskSourceContext {
  return settings !== null && settings !== undefined && 'kind' in settings
}

export function getRedmineRuntimeTarget(
  settings: RuntimeRedmineSettings
): ReturnType<typeof getActiveRuntimeTarget> {
  return getActiveRuntimeTarget(
    isTaskSourceRuntimeSettings(settings) ? getTaskSourceRuntimeSettings(settings) : settings
  )
}

function normalizeRedmineIssueCollectionResult(result: unknown): RedmineIssueCollectionResult {
  if (!result || typeof result !== 'object') {
    return { items: [], totalCount: 0 }
  }
  const collection = result as Partial<RedmineIssueCollectionResult>
  if (!Array.isArray(collection.items)) {
    return { items: [], totalCount: 0 }
  }
  return {
    items: collection.items,
    totalCount: typeof collection.totalCount === 'number' ? collection.totalCount : 0,
    ...(collection.error ? { error: collection.error } : {})
  }
}

export async function redmineStatus(
  settings: RuntimeRedmineSettings
): Promise<RedmineConnectionStatus> {
  const target = getRedmineRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<RedmineConnectionStatus>(target, 'redmine.status', undefined, {
        timeoutMs: 15_000
      })
    : window.api.redmine.status()
}

export async function redmineTestConnection(
  settings: RuntimeRedmineSettings,
  args: { siteUrl: string; apiKey: string }
): Promise<RedmineTestConnectionResult> {
  const target = getRedmineRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<RedmineTestConnectionResult>(target, 'redmine.testConnection', args, {
        timeoutMs: 30_000
      })
    : window.api.redmine.testConnection(args)
}

export async function redmineConnect(
  settings: RuntimeRedmineSettings,
  args: { siteUrl: string; apiKey: string }
): Promise<RedmineConnectResult> {
  const target = getRedmineRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<RedmineConnectResult>(target, 'redmine.connect', args, {
        timeoutMs: 30_000
      })
    : window.api.redmine.connect(args)
}

export async function redmineDisconnect(
  settings: RuntimeRedmineSettings,
  siteId?: string | null
): Promise<void> {
  const target = getRedmineRuntimeTarget(settings)
  if (target.kind === 'environment') {
    await callRuntimeRpc<{ ok: true }>(
      target,
      'redmine.disconnect',
      siteId ? { siteId } : undefined,
      { timeoutMs: 15_000 }
    )
    return
  }
  if (siteId) {
    await window.api.redmine.disconnect({ siteId })
  }
}

export async function redmineListIssues(
  settings: RuntimeRedmineSettings,
  filter?: RedmineListFilter
): Promise<RedmineIssueCollectionResult> {
  const target = getRedmineRuntimeTarget(settings)
  const result =
    target.kind === 'environment'
      ? await callRuntimeRpc<unknown>(
          target,
          'redmine.listIssues',
          filter ? { filter } : undefined,
          {
            timeoutMs: 30_000
          }
        )
      : await window.api.redmine.listIssues(filter ? { filter } : undefined)
  return normalizeRedmineIssueCollectionResult(result)
}

export type RedmineIssueDetailResult = {
  issue: RedmineIssue | null
  error?: RedmineReadError
}

export async function redmineGetIssue(
  settings: RuntimeRedmineSettings,
  issueId: number
): Promise<RedmineIssueDetailResult> {
  const target = getRedmineRuntimeTarget(settings)
  const result: unknown =
    target.kind === 'environment'
      ? await callRuntimeRpc<unknown>(
          target,
          'redmine.getIssue',
          { issueId },
          { timeoutMs: 30_000 }
        )
      : await window.api.redmine.getIssue({ issueId })
  return normalizeRedmineIssueDetailResult(result)
}

function normalizeRedmineIssueDetailResult(result: unknown): RedmineIssueDetailResult {
  if (!result || typeof result !== 'object') {
    return { issue: null }
  }
  const detail = result as Partial<RedmineIssueDetailResult>
  return {
    issue: detail.issue ?? null,
    ...(detail.error ? { error: detail.error } : {})
  }
}
