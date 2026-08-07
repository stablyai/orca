import type { AiVaultListArgs, AiVaultListResult } from '../../../shared/ai-vault-types'
import { isAiVaultTitleAgent } from '../../../shared/ai-vault-session-title'
import type { AppState } from '@/store/types'
import {
  collectAiVaultTitleRequests,
  type AiVaultTitleRequest
} from './ai-vault-tab-title-requests'
import { groupAiVaultTitleRequests } from './ai-vault-tab-title-scan-groups'
import { aiVaultTitleSyncInputsChanged } from './ai-vault-tab-title-sync-inputs'

const LIVE_TITLE_REFRESH_MS = 20_000

function requestIdentity(request: AiVaultTitleRequest): string {
  return `${request.executionHostId}\0${request.agent}\0${request.providerSession.id}`
}

type SyncDependencies = {
  getState: () => AppState
  listSessions: (args: AiVaultListArgs) => Promise<AiVaultListResult>
  subscribe: (listener: (state: AppState, previous: AppState) => void) => () => void
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout> | number
  clearTimer?: (timer: ReturnType<typeof setTimeout> | number) => void
}

export function startAiVaultTabTitleSync(dependencies: SyncDependencies): () => void {
  const setTimer = dependencies.setTimer ?? setTimeout
  const clearTimer =
    dependencies.clearTimer ??
    ((timer: ReturnType<typeof setTimeout> | number) =>
      clearTimeout(timer as ReturnType<typeof setTimeout>))
  let refreshTimer: ReturnType<typeof setTimeout> | number | null = null
  let scanInFlight = false
  let scanAgain = false
  let scheduled = false
  let stopped = false
  let writing = false

  const writeTitle = (request: AiVaultTitleRequest, title: string | null): void => {
    writing = true
    try {
      dependencies
        .getState()
        .setAiVaultTabTitle(
          request.tabId,
          title ? { agent: request.agent, sessionId: request.providerSession.id, title } : null
        )
    } finally {
      writing = false
    }
  }

  const scanGroup = async (requests: AiVaultTitleRequest[]): Promise<void> => {
    const first = requests[0]!
    const scopePaths = [...new Set(requests.flatMap((request) => request.scopePath ?? []))]
    const result = await dependencies.listSessions({
      executionHostScope: first.executionHostId,
      ...(scopePaths.length > 0 ? { scopePaths } : {}),
      limit: 500
    })
    if (stopped || result.cancelled) {
      return
    }
    const titleByIdentity = new Map<string, string>()
    for (const session of result.sessions) {
      if (isAiVaultTitleAgent(session.agent) && session.title.trim()) {
        titleByIdentity.set(
          `${session.executionHostId}\0${session.agent}\0${session.sessionId}`,
          session.title.trim()
        )
      }
    }
    const currentByTabId = new Map(
      collectAiVaultTitleRequests(dependencies.getState()).map((request) => [
        request.tabId,
        request
      ])
    )
    for (const request of requests) {
      const current = currentByTabId.get(request.tabId)
      const title = titleByIdentity.get(requestIdentity(request))
      if (current && requestIdentity(current) === requestIdentity(request) && title) {
        writeTitle(request, title)
      }
    }
  }

  const reconcile = async (): Promise<void> => {
    scheduled = false
    if (stopped) {
      return
    }
    if (scanInFlight) {
      scanAgain = true
      return
    }
    if (refreshTimer !== null) {
      clearTimer(refreshTimer)
      refreshTimer = null
    }

    const state = dependencies.getState()
    const tabsById = new Map(
      Object.values(state.tabsByWorktree)
        .flat()
        .map((tab) => [tab.id, tab] as const)
    )
    const requests = collectAiVaultTitleRequests(state)
    const requestsToScan = requests.filter((request) => {
      const stored = tabsById.get(request.tabId)?.aiVaultTitle
      const identityMatches =
        stored?.agent === request.agent && stored.sessionId === request.providerSession.id
      if (stored && !identityMatches) {
        writeTitle(request, null)
      }
      return request.refresh || !identityMatches || !stored?.title.trim()
    })

    if (requestsToScan.length > 0) {
      scanInFlight = true
      await Promise.allSettled(groupAiVaultTitleRequests(requestsToScan).map(scanGroup))
      scanInFlight = false
    }

    if (scanAgain) {
      scanAgain = false
      schedule()
    } else if (!stopped && requests.some((request) => request.refresh)) {
      refreshTimer = setTimer(schedule, LIVE_TITLE_REFRESH_MS)
    }
  }

  function schedule(): void {
    if (scheduled || stopped) {
      return
    }
    scheduled = true
    queueMicrotask(() => void reconcile())
  }

  const unsubscribe = dependencies.subscribe((state, previous) => {
    if (!writing && aiVaultTitleSyncInputsChanged(state, previous)) {
      schedule()
    }
  })
  schedule()

  return () => {
    stopped = true
    unsubscribe()
    if (refreshTimer !== null) {
      clearTimer(refreshTimer)
    }
  }
}
