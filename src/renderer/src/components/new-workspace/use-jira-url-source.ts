import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { assertRuntimeEnvironmentCapability } from '@/runtime/runtime-rpc-client'
import {
  getMatchingJiraSites,
  isResolvedJiraIssueMatch,
  parseJiraIssueUrl,
  type ParsedJiraIssueUrl
} from '../../../../shared/jira-issue-url'
import { getJiraSummaryLookupErrorCode } from '../../../../shared/jira-summary-lookup'
import {
  getTaskSourceCacheScope,
  normalizeTaskSourceContext,
  type TaskSourceContext
} from '../../../../shared/task-source-context'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { JiraIssue, JiraSite } from '../../../../shared/types'
import { canReuseLoadedJiraStatus, type JiraSourceConnection } from './use-jira-source-connection'

const LOOKUP_DEBOUNCE_MS = 200
const UPDATE_RUNTIME_ERROR = 'update-runtime'

export type JiraUrlSourceError =
  | 'disconnected'
  | 'site-not-connected'
  | 'read-failed'
  | typeof UPDATE_RUNTIME_ERROR

export type JiraUrlSourceState = {
  intent: boolean
  loading: boolean
  issue: JiraIssue | null
  boundSourceContext: TaskSourceContext | null
  accountChoices: JiraSite[]
  errorKind: JiraUrlSourceError | null
  selectAccount: (siteId: string) => void
  retry: () => void
}

type AccountSelection = {
  requestKey: string
  siteId: string
}

type JiraUrlLookupState = Pick<
  JiraUrlSourceState,
  'loading' | 'issue' | 'boundSourceContext' | 'accountChoices' | 'errorKind'
> & {
  attemptKey: string | null
}

function getPreferredSite(
  matches: JiraSite[],
  selectedAccount: AccountSelection | null,
  requestKey: string,
  selectedSiteId: (string & {}) | 'all' | null | undefined,
  activeSiteId: string | null | undefined
): JiraSite | null {
  const explicitId = selectedAccount?.requestKey === requestKey ? selectedAccount.siteId : null
  for (const siteId of [
    explicitId,
    selectedSiteId === 'all' ? null : selectedSiteId,
    activeSiteId
  ]) {
    const site = matches.find((candidate) => candidate.id === siteId)
    if (site) {
      return site
    }
  }
  return matches.length === 1 ? matches[0] : null
}

export function bindJiraIssueSourceContext(
  sourceContext: TaskSourceContext,
  site: JiraSite,
  issue: JiraIssue
): TaskSourceContext | null {
  return normalizeTaskSourceContext({
    provider: 'jira',
    projectId: sourceContext.projectId,
    hostId: sourceContext.hostId,
    projectHostSetupId: sourceContext.projectHostSetupId,
    repoId: sourceContext.repoId,
    providerIdentity: {
      provider: 'jira',
      siteId: site.id,
      siteUrl: site.siteUrl,
      projectKey: issue.project.key
    },
    accountLabel: site.email || site.displayName
  })
}

function getRequestKey(parsed: ParsedJiraIssueUrl, sourceContext: TaskSourceContext): string {
  return `${parsed.origin}${parsed.sitePath}/browse/${parsed.issueKey}::${getTaskSourceCacheScope(sourceContext)}`
}

export function useJiraUrlSource(args: {
  value: string
  enabled: boolean
  sourceContext: TaskSourceContext | null
  connection?: JiraSourceConnection | null
}): JiraUrlSourceState {
  const readJiraStatus = useAppStore((state) => state.readJiraStatus)
  const lookupJiraIssueSummary = useAppStore((state) => state.lookupJiraIssueSummary)
  const parsed = useMemo(
    () => (args.enabled ? parseJiraIssueUrl(args.value) : null),
    [args.enabled, args.value]
  )
  const requestKey = parsed && args.sourceContext ? getRequestKey(parsed, args.sourceContext) : null
  const [selectedAccount, setSelectedAccount] = useState<AccountSelection | null>(null)
  const [retryGeneration, setRetryGeneration] = useState(0)
  const attemptKey = requestKey
    ? `${requestKey}::${selectedAccount?.requestKey === requestKey ? selectedAccount.siteId : ''}::${retryGeneration}`
    : null
  const requestGenerationRef = useRef(0)
  const consumedRetryGenerationRef = useRef(0)
  const [state, setState] = useState<JiraUrlLookupState>({
    attemptKey: null,
    loading: false,
    issue: null,
    boundSourceContext: null,
    accountChoices: [],
    errorKind: null
  })

  useEffect(() => {
    const generation = (requestGenerationRef.current += 1)
    const sourceContext = args.sourceContext
    if (!parsed || !sourceContext || !requestKey || !attemptKey) {
      return
    }
    const settle = (result: Omit<JiraUrlLookupState, 'attemptKey' | 'loading'>): void => {
      if (requestGenerationRef.current === generation) {
        setState({ ...result, attemptKey, loading: false })
      }
    }
    const fail = (errorKind: JiraUrlSourceError): void =>
      settle({ issue: null, boundSourceContext: null, accountChoices: [], errorKind })

    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      timer = null
      const run = async (): Promise<void> => {
        try {
          const parsedHost = parseExecutionHostId(sourceContext.hostId)
          if (parsedHost?.kind === 'runtime') {
            await assertRuntimeEnvironmentCapability(
              parsedHost.environmentId,
              WORKTREE_LINKED_WORK_ITEM_CONTEXT_RUNTIME_CAPABILITY,
              UPDATE_RUNTIME_ERROR
            )
          }
          const force = retryGeneration > consumedRetryGenerationRef.current
          const connection = args.connection
          const status = canReuseLoadedJiraStatus(connection, force)
            ? connection.status
            : await readJiraStatus(sourceContext)
          if (requestGenerationRef.current !== generation) {
            return
          }
          if (!status.connected) {
            fail('disconnected')
            return
          }
          const matches = getMatchingJiraSites(parsed, status.sites ?? [])
          if (matches.length === 0) {
            fail('site-not-connected')
            return
          }
          const site = getPreferredSite(
            matches,
            selectedAccount,
            requestKey,
            status.selectedSiteId,
            status.activeSiteId
          )
          if (!site) {
            settle({
              issue: null,
              boundSourceContext: null,
              accountChoices: matches,
              errorKind: null
            })
            return
          }
          consumedRetryGenerationRef.current = retryGeneration
          const issue = await lookupJiraIssueSummary(sourceContext, parsed.issueKey, site.id, {
            force,
            signal: controller.signal
          })
          if (!issue || !isResolvedJiraIssueMatch(parsed, site, issue)) {
            fail('read-failed')
            return
          }
          const boundSourceContext = bindJiraIssueSourceContext(sourceContext, site, issue)
          settle({
            issue,
            boundSourceContext,
            accountChoices: [],
            errorKind: boundSourceContext ? null : 'read-failed'
          })
        } catch (error) {
          const summaryCode = getJiraSummaryLookupErrorCode(error)
          const updateRequired =
            error instanceof Error && error.message.includes(UPDATE_RUNTIME_ERROR)
          fail(
            updateRequired
              ? UPDATE_RUNTIME_ERROR
              : summaryCode === 'disconnected'
                ? 'disconnected'
                : 'read-failed'
          )
        }
      }
      void run()
    }, LOOKUP_DEBOUNCE_MS)

    return () => {
      requestGenerationRef.current += 1
      controller.abort()
      if (timer !== null) {
        clearTimeout(timer)
      }
    }
  }, [
    args.connection,
    args.sourceContext,
    attemptKey,
    lookupJiraIssueSummary,
    parsed,
    readJiraStatus,
    requestKey,
    retryGeneration,
    selectedAccount
  ])

  const selectAccount = useCallback(
    (siteId: string): void => {
      if (requestKey) {
        setSelectedAccount({ requestKey, siteId })
      }
    },
    [requestKey]
  )
  const retry = useCallback((): void => {
    setRetryGeneration((current) => current + 1)
  }, [])

  const visibleState =
    state.attemptKey === attemptKey
      ? state
      : {
          loading: attemptKey !== null,
          issue: null,
          boundSourceContext: null,
          accountChoices: [],
          errorKind: null
        }
  return {
    intent: parsed !== null,
    loading: visibleState.loading,
    issue: visibleState.issue,
    boundSourceContext: visibleState.boundSourceContext,
    accountChoices: visibleState.accountChoices,
    errorKind: visibleState.errorKind,
    selectAccount,
    retry
  }
}
