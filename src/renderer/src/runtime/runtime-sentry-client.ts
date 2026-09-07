import type { GlobalSettings } from '../../../shared/global-settings-types'
import type {
  SentryAssignee,
  SentryConnectionStatus,
  SentryEnvironment,
  SentryEvent,
  SentryIssue,
  SentryIssueQuery,
  SentryIssueUpdate,
  SentryMutationResult,
  SentryPage,
  SentryProject
} from '../../../shared/sentry-types'
import {
  getActiveRuntimeTarget,
  assertRuntimeEnvironmentCapability,
  callRuntimeRpc
} from './runtime-rpc-client'
import {
  SENTRY_ISSUES_RUNTIME_CAPABILITY,
  SENTRY_ISSUES_UPDATE_REQUIRED_MESSAGE
} from '../../../shared/protocol-version'

export type RuntimeSentrySettings =
  | Pick<GlobalSettings, 'activeRuntimeEnvironmentId'>
  | null
  | undefined

const target = (settings: RuntimeSentrySettings) => getActiveRuntimeTarget(settings)

async function call<TResult>(
  settings: RuntimeSentrySettings,
  method: string,
  params?: unknown,
  signal?: AbortSignal
): Promise<TResult> {
  const runtimeTarget = target(settings)
  if (runtimeTarget.kind === 'environment') {
    await assertRuntimeEnvironmentCapability(
      runtimeTarget.environmentId,
      SENTRY_ISSUES_RUNTIME_CAPABILITY,
      SENTRY_ISSUES_UPDATE_REQUIRED_MESSAGE,
      15_000
    )
  }
  return callRuntimeRpc<TResult>(runtimeTarget, method, params, {
    timeoutMs: 30_000,
    signal
  })
}

export function sentryStatus(settings: RuntimeSentrySettings): Promise<SentryConnectionStatus> {
  return target(settings).kind === 'environment'
    ? call(settings, 'sentry.status')
    : window.api.sentry.status()
}

export function sentryConnect(
  settings: RuntimeSentrySettings,
  args: { baseUrl: string; token: string; organizationSlug?: string }
) {
  return target(settings).kind === 'environment'
    ? call<Awaited<ReturnType<typeof window.api.sentry.connect>>>(settings, 'sentry.connect', args)
    : window.api.sentry.connect(args)
}

export async function sentryDisconnect(settings: RuntimeSentrySettings): Promise<void> {
  await (target(settings).kind === 'environment'
    ? call(settings, 'sentry.disconnect')
    : window.api.sentry.disconnect())
}

export function sentrySelectOrganization(settings: RuntimeSentrySettings, slug: string) {
  return target(settings).kind === 'environment'
    ? call<SentryConnectionStatus>(settings, 'sentry.selectOrganization', { slug })
    : window.api.sentry.selectOrganization({ slug })
}

export function sentryTestConnection(settings: RuntimeSentrySettings) {
  return target(settings).kind === 'environment'
    ? call<Awaited<ReturnType<typeof window.api.sentry.testConnection>>>(
        settings,
        'sentry.testConnection'
      )
    : window.api.sentry.testConnection()
}

export function sentryListProjects(settings: RuntimeSentrySettings): Promise<SentryProject[]> {
  return target(settings).kind === 'environment'
    ? call(settings, 'sentry.listProjects')
    : window.api.sentry.listProjects()
}

export function sentryListEnvironments(
  settings: RuntimeSentrySettings
): Promise<SentryEnvironment[]> {
  return target(settings).kind === 'environment'
    ? call(settings, 'sentry.listEnvironments')
    : window.api.sentry.listEnvironments()
}

export function sentryListAssignees(settings: RuntimeSentrySettings): Promise<SentryAssignee[]> {
  return target(settings).kind === 'environment'
    ? call(settings, 'sentry.listAssignees')
    : window.api.sentry.listAssignees()
}

export function sentryListIssues(
  settings: RuntimeSentrySettings,
  query: SentryIssueQuery,
  signal?: AbortSignal
): Promise<SentryPage<SentryIssue>> {
  return target(settings).kind === 'environment'
    ? call(settings, 'sentry.listIssues', query, signal)
    : window.api.sentry.listIssues(query)
}

export function sentryGetIssue(
  settings: RuntimeSentrySettings,
  issueId: string
): Promise<SentryIssue | null> {
  return target(settings).kind === 'environment'
    ? call(settings, 'sentry.getIssue', { issueId })
    : window.api.sentry.getIssue({ issueId })
}

export function sentryListEvents(
  settings: RuntimeSentrySettings,
  issueId: string,
  cursor?: string
): Promise<SentryPage<SentryEvent>> {
  const args = { issueId, cursor }
  return target(settings).kind === 'environment'
    ? call(settings, 'sentry.listEvents', args)
    : window.api.sentry.listEvents(args)
}

export function sentryUpdateIssue(
  settings: RuntimeSentrySettings,
  issueId: string,
  updates: SentryIssueUpdate
): Promise<SentryMutationResult> {
  const args = { issueId, updates }
  return target(settings).kind === 'environment'
    ? call(settings, 'sentry.updateIssue', args)
    : window.api.sentry.updateIssue(args)
}
