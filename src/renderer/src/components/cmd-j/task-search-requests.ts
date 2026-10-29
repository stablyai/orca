import { useAppStore } from '@/store'
import { linearSearchIssuesForTarget, linearStatusForTarget } from '@/runtime/runtime-linear-client'
import { jiraSearchIssuesForTarget, jiraStatusForTarget } from '@/runtime/runtime-jira-client'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/runtime-client-target'
import { gitLabApiFor } from '@/runtime/gitlab-owner-api'
import { resolveJiraSourceHostId } from '../../../../shared/jira/jira-source-host'
import { getJiraAccountLabel } from '@/lib/jira-account-label'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  normalizeTaskSourceContext,
  type TaskSourceContext
} from '../../../../shared/task-source-context'
import { normalizeVisibleTaskProviders, type TaskProvider } from '../../../../shared/task-providers'
import type { Repo } from '../../../../shared/repo-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { PaletteFilterState } from './palette-filter'
import { getTaskEligibleRepos } from '../task-page/task-page-default-repo-selection'
import { getRepoBackedProviderAvailability } from '../task-source-provider-availability'
import { getTaskPageRepoSourceContext } from '../task-page/task-page-source-context'
import { searchJiraIssuesByKeyOrText } from '../jira-key-or-text-search'
import { bindTaskPageJiraItemSourceContext } from '../task-page-jira-item-source-context'
import { makeCmdJTaskSearchResult, type CmdJTaskSearchResult } from './task-search-results'

const RESULT_LIMIT = 12
export type CmdJTaskSearchRequest = {
  id: string
  provider: TaskProvider
  hostLabel: string
  run: () => Promise<CmdJTaskSearchResult[]>
}

export function createCmdJTaskSearchRequests(args: {
  query: string
  repos: readonly Repo[]
  settings: GlobalSettings | null
  accountBackedTaskSourceHostId: ExecutionHostId
  filter: PaletteFilterState
  hostLabels: ReadonlyMap<string, string>
  signal: AbortSignal
}): CmdJTaskSearchRequest[] {
  const { query, settings, filter, signal, hostLabels } = args
  const state = useAppStore.getState()
  const providers = normalizeVisibleTaskProviders(settings?.visibleTaskProviders)
  const requests: CmdJTaskSearchRequest[] = []
  const eligibleRepos = args.repos.filter(
    (repo) =>
      (!filter.repoIds.length || filter.repoIds.includes(repo.id)) &&
      (!filter.hostIds.length || filter.hostIds.includes(getRepoExecutionHostId(repo)))
  )
  for (const repo of getTaskEligibleRepos(eligibleRepos)) {
    for (const provider of ['github', 'gitlab'] as const) {
      if (!providers.includes(provider)) {
        continue
      }
      const source = getTaskPageRepoSourceContext(repo, provider)
      if (!source) {
        continue
      }
      if (
        getRepoBackedProviderAvailability({
          provider,
          contexts: [source],
          preflightStatus: state.preflightStatus,
          preflightReady: source.hostId === 'local' && state.preflightStatusChecked
        }).length
      ) {
        continue
      }
      const hostLabel = hostLabels.get(source.hostId) ?? source.hostId
      requests.push({
        id: `${provider}:${source.hostId}:${repo.id}`,
        provider,
        hostLabel,
        run: async () => {
          if (signal.aborted) {
            return []
          }
          if (provider === 'github') {
            const items = await state.fetchWorkItems(
              repo.id,
              repo.path,
              RESULT_LIMIT,
              `is:issue is:open ${query}`,
              { sourceContext: source, requireComplete: true }
            )
            return items
              .filter((issue) => issue.type === 'issue' && issue.state === 'open')
              .map((issue) =>
                makeCmdJTaskSearchResult({ provider, issue }, source, repo.id, hostLabel)
              )
          }
          const result = await gitLabApiFor({
            repoPath: repo.path,
            repoId: repo.id,
            sourceContext: source,
            repoOwnerExecutionHostId: getRepoExecutionHostId(repo)
          }).listWorkItems({
            repoPath: repo.path,
            repoId: repo.id,
            sourceContext: source,
            state: 'opened',
            page: 1,
            perPage: RESULT_LIMIT,
            query
          })
          if (result.error?.type === 'not_found') {
            return []
          }
          if (result.error && result.items.length === 0) {
            throw new Error(result.error.message)
          }
          return result.items
            .filter((issue) => issue.type === 'issue' && issue.state === 'opened')
            .map((issue) => {
              const item = { ...issue, repoId: repo.id }
              const itemSource =
                getTaskPageRepoSourceContext(repo, provider, issue.projectRef) ?? source
              return makeCmdJTaskSearchResult(
                { provider, issue: item },
                itemSource,
                repo.id,
                hostLabel
              )
            })
        }
      })
    }
  }
  const hostIds = filter.hostIds.length
    ? filter.hostIds
    : filter.repoIds.length
      ? [...new Set(eligibleRepos.map(getRepoExecutionHostId))]
      : [args.accountBackedTaskSourceHostId]
  const accountRequestIds = new Set<string>()
  for (const requestedHostId of hostIds) {
    const parsed = parseExecutionHostId(requestedHostId)
    if (!parsed) {
      continue
    }
    const initialRepo =
      eligibleRepos.find((repo) => getRepoExecutionHostId(repo) === requestedHostId) ?? null
    if (filter.repoIds.length && !initialRepo) {
      continue
    }
    for (const provider of ['linear', 'jira'] as const) {
      if (!providers.includes(provider) || (provider === 'linear' && parsed.kind === 'ssh')) {
        continue
      }
      // Jira credentials stay on the desktop for SSH repositories; runtime hosts own theirs.
      const hostId =
        provider === 'jira'
          ? resolveJiraSourceHostId({ workspaceHostId: requestedHostId })
          : parsed.id
      const requestId = `${provider}:${hostId}`
      const target = ipcOrRuntimeTargetForHostId(hostId)
      if (!target || accountRequestIds.has(requestId)) {
        continue
      }
      const hostLabel = hostLabels.get(hostId) ?? hostId
      const source = normalizeTaskSourceContext({
        provider,
        projectId:
          (initialRepo ? getTaskPageRepoSourceContext(initialRepo, 'github')?.projectId : null) ??
          initialRepo?.id ??
          'account-backed-task-source',
        hostId,
        repoId: initialRepo?.id ?? null
      })
      if (!source) {
        continue
      }
      accountRequestIds.add(requestId)
      requests.push({
        id: requestId,
        provider,
        hostLabel,
        run: async () => {
          if (signal.aborted) {
            return []
          }
          return provider === 'linear'
            ? searchLinear(source, target, query, signal, initialRepo?.id ?? null, hostLabel)
            : searchJira(source, target, query, signal, initialRepo?.id ?? null, hostLabel)
        }
      })
    }
  }
  return requests
}

async function searchLinear(
  source: TaskSourceContext,
  target: RuntimeClientTarget,
  query: string,
  signal: AbortSignal,
  initialRepoId: string | null,
  hostLabel: string
): Promise<CmdJTaskSearchResult[]> {
  const status = await linearStatusForTarget(target)
  if (signal.aborted || !status.connected) {
    return []
  }
  const workspaceId = status.selectedWorkspaceId ?? status.activeWorkspaceId ?? undefined
  const issues = await linearSearchIssuesForTarget(target, query, RESULT_LIMIT, workspaceId)
  return issues.flatMap((issue) => {
    const itemSource = normalizeTaskSourceContext({
      ...source,
      providerIdentity: {
        provider: 'linear',
        workspaceId: issue.workspaceId ?? (workspaceId === 'all' ? null : workspaceId) ?? null,
        workspaceName: issue.workspaceName ?? null,
        teamId: issue.team.id,
        teamKey: issue.team.key
      },
      accountLabel: issue.workspaceName ?? null
    })
    return itemSource
      ? [
          makeCmdJTaskSearchResult(
            { provider: 'linear', issue },
            itemSource,
            initialRepoId,
            hostLabel
          )
        ]
      : []
  })
}

async function searchJira(
  source: TaskSourceContext,
  target: RuntimeClientTarget,
  query: string,
  signal: AbortSignal,
  initialRepoId: string | null,
  hostLabel: string
): Promise<CmdJTaskSearchResult[]> {
  const status = await jiraStatusForTarget(target)
  if (signal.aborted || !status.connected) {
    return []
  }
  const siteId = status.selectedSiteId ?? status.activeSiteId ?? undefined
  const issues = await searchJiraIssuesByKeyOrText(query, (jql) =>
    jiraSearchIssuesForTarget(target, jql, RESULT_LIMIT, siteId, signal)
  )
  return issues.flatMap((issue) => {
    const itemSource =
      bindTaskPageJiraItemSourceContext({
        issue,
        sites: status.sites ?? [],
        sourceContext: source
      }) ??
      normalizeTaskSourceContext({
        ...source,
        providerIdentity: { provider: 'jira', siteId: issue.siteId ?? null, siteUrl: null },
        accountLabel: getJiraAccountLabel(status.viewer)
      })
    return itemSource
      ? [
          makeCmdJTaskSearchResult(
            { provider: 'jira', issue },
            itemSource,
            initialRepoId,
            hostLabel
          )
        ]
      : []
  })
}
