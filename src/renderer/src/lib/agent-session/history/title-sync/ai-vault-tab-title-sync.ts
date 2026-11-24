import type {
  AiVaultSessionTitle,
  AiVaultSessionTitlesArgs,
  AiVaultSessionTitlesResult
} from '../../../../../../shared/ai-vault/contracts/ai-vault-session-title'
import type { AppState } from '@/store/types'
import type { RuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-owner'
import {
  collectAiVaultTitleRequests,
  type AiVaultTitleRequest
} from './ai-vault-tab-title-requests'
import { settleAiVaultTitleRequestBatches } from './ai-vault-tab-title-batches'
import {
  aiVaultTitleRequestInputsChanged,
  aiVaultTitleSyncInputsChanged
} from './ai-vault-tab-title-sync-inputs'
import {
  aiVaultTitleRequestInputs,
  type AiVaultTitleRequestInputs
} from './ai-vault-tab-title-request-inputs'

import {
  aiVaultTitleRequestKey,
  changedOwningPaneTitleRequests,
  changedTitleRefreshHosts,
  storedAiVaultTitles,
  titleRefreshInterval,
  supportsSessionTitleRefresh
} from './ai-vault-tab-title-freshness'

function requestIdentity(request: AiVaultTitleRequest): string {
  return `${request.executionHostId}\0${request.agent}\0${request.providerSession.id}`
}

type RequestSnapshot = {
  inputs: AiVaultTitleRequestInputs
  requests: AiVaultTitleRequest[]
  byKey: Map<string, AiVaultTitleRequest>
  byTabId: Map<string, AiVaultTitleRequest>
}

type SyncDependencies = {
  getState: () => AppState
  resolveSessionTitles: (args: AiVaultSessionTitlesArgs) => Promise<AiVaultSessionTitlesResult>
  subscribe: (
    listener: (
      state: AppState,
      previous: AppState,
      statuses: RuntimeStatuses,
      previousStatuses: RuntimeStatuses
    ) => void
  ) => () => void
  readStatuses: () => RuntimeStatuses
  scheduleReconcile?: (callback: () => void) => () => void
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout> | number
  clearTimer?: (timer: ReturnType<typeof setTimeout> | number) => void
}

function scheduleMicrotask(callback: () => void): () => void {
  let cancelled = false
  queueMicrotask(() => {
    if (!cancelled) {
      callback()
    }
  })
  return () => {
    cancelled = true
  }
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
  let cancelScheduled: (() => void) | null = null
  let stopped = false
  let writing = false
  const lastSettledAttemptAt = new Map<string, number>()
  const dirty = new Set<string>()
  // Why: rebuilding requests walks every tab and conversation; a pass and its batches reuse them until an input changes.
  let snapshot: RequestSnapshot | null = null

  const currentRequests = (state = dependencies.getState()): RequestSnapshot => {
    if (snapshot && !aiVaultTitleRequestInputsChanged(state, snapshot.inputs)) {
      snapshot.inputs = aiVaultTitleRequestInputs(state)
      return snapshot
    }
    const requests = collectAiVaultTitleRequests(state)
    snapshot = {
      inputs: aiVaultTitleRequestInputs(state),
      requests,
      byKey: new Map(requests.map((request) => [aiVaultTitleRequestKey(request), request])),
      byTabId: new Map(requests.map((request) => [request.tabId, request]))
    }
    return snapshot
  }

  const writeTitle = (
    request: AiVaultTitleRequest,
    title: Pick<AiVaultSessionTitle, 'title' | 'kind'> | null
  ): void => {
    writing = true
    try {
      dependencies.getState().setAiVaultTabTitle(
        request.tabId,
        title
          ? {
              agent: request.agent,
              sessionId: request.providerSession.id,
              title: title.title,
              ...(title.kind ? { kind: title.kind } : {})
            }
          : null
      )
    } finally {
      writing = false
    }
  }

  const resolveBatch = async (requests: AiVaultTitleRequest[]): Promise<void> => {
    const first = requests[0]!
    const result = await dependencies.resolveSessionTitles({
      executionHostScope: first.executionHostId,
      requests: requests.map((request) => ({
        agent: request.agent,
        sessionId: request.providerSession.id,
        ...(request.providerSession.transcriptPath
          ? { transcriptPath: request.providerSession.transcriptPath }
          : {})
      }))
    })
    if (stopped) {
      return
    }
    const titleByIdentity = new Map<string, Pick<AiVaultSessionTitle, 'title' | 'kind'>>()
    for (const title of result.titles) {
      if (title.title.trim()) {
        titleByIdentity.set(`${first.executionHostId}\0${title.agent}\0${title.sessionId}`, {
          title: title.title.trim(),
          kind: title.kind
        })
      }
    }
    const currentByTabId = currentRequests().byTabId
    for (const request of requests) {
      const current = currentByTabId.get(request.tabId)
      const title = titleByIdentity.get(requestIdentity(request))
      if (current && aiVaultTitleRequestKey(current) === aiVaultTitleRequestKey(request) && title) {
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
    const statuses = dependencies.readStatuses()
    const { requests, byKey: currentKeys } = currentRequests(state)
    for (const key of lastSettledAttemptAt.keys()) {
      if (!currentKeys.has(key)) {
        lastSettledAttemptAt.delete(key)
      }
    }
    for (const key of dirty) {
      if (!currentKeys.has(key)) {
        dirty.delete(key)
      }
    }
    const now = Date.now()
    const storedTitles = storedAiVaultTitles(state, requests)
    const requestsToScan = requests.filter((request) => {
      const stored = storedTitles(request)
      const identityMatches =
        stored?.agent === request.agent && stored.sessionId === request.providerSession.id
      if (stored && !identityMatches) {
        writeTitle(request, null)
      }
      const last = lastSettledAttemptAt.get(aiVaultTitleRequestKey(request))
      return (
        !identityMatches ||
        !stored?.title.trim() ||
        (request.refresh && last === undefined) ||
        // Titles saved before they carried a kind are asked for once, so a sleeping session's name can outrank its quick-command label.
        (!stored?.kind && last === undefined) ||
        (request.refresh &&
          (dirty.has(aiVaultTitleRequestKey(request)) ||
            now - last! >=
              titleRefreshInterval(statuses, request, stored) /
                (supportsSessionTitleRefresh(statuses, request) ? 2 : 1)))
      )
    })

    if (requestsToScan.length > 0) {
      scanInFlight = true
      for (const request of requestsToScan) {
        dirty.delete(aiVaultTitleRequestKey(request))
      }
      await settleAiVaultTitleRequestBatches(
        requestsToScan,
        async (batch) => {
          try {
            await resolveBatch(batch)
          } finally {
            // Failed attempts pace live refreshes without settling a missing name.
            for (const request of batch) {
              lastSettledAttemptAt.set(aiVaultTitleRequestKey(request), Date.now())
            }
          }
        },
        () => (stopped ? new Map() : currentRequests().byKey)
      )
      scanInFlight = false
    }

    if (scanAgain) {
      scanAgain = false
      schedule()
    } else if (!stopped) {
      const currentState = dependencies.getState()
      const currentStatuses = dependencies.readStatuses()
      const { requests: currentRequestList } = currentRequests(currentState)
      const currentStoredTitles = storedAiVaultTitles(currentState, currentRequestList)
      const delays = currentRequestList
        .filter((request) => request.refresh)
        .map((request) =>
          Math.max(
            0,
            (lastSettledAttemptAt.get(aiVaultTitleRequestKey(request)) ?? Date.now()) +
              titleRefreshInterval(currentStatuses, request, currentStoredTitles(request)) -
              Date.now()
          )
        )
      if (delays.length > 0) {
        refreshTimer = setTimer(schedule, Math.min(...delays))
      } else {
        // Nothing comes back on a timer, so don't hold old store inputs until the next change.
        snapshot = null
      }
    }
  }

  function schedule(): void {
    if (scheduled || stopped) {
      return
    }
    scheduled = true
    cancelScheduled = (dependencies.scheduleReconcile ?? scheduleMicrotask)(() => {
      cancelScheduled = null
      void reconcile()
    })
  }

  const unsubscribe = dependencies.subscribe((state, previous, statuses, previousStatuses) => {
    if (writing) {
      return
    }
    if (state.runtimePaneTitlesByTabId !== previous.runtimePaneTitlesByTabId) {
      for (const key of changedOwningPaneTitleRequests(state, previous, statuses)) {
        dirty.add(key)
      }
    }
    if (dirty.size > 0 || aiVaultTitleSyncInputsChanged(state, previous)) {
      schedule()
      return
    }
    // Why: host-status pings are frequent and usually leave capabilities alone; walking every saved tab on each
    // one stalled typing in large workspaces, so only collect when some host's title-refresh support flipped.
    const changedHosts = changedTitleRefreshHosts(statuses, previousStatuses)
    if (
      changedHosts.size > 0 &&
      collectAiVaultTitleRequests(state).some((request) =>
        changedHosts.has(request.executionHostId)
      )
    ) {
      schedule()
    }
  })
  schedule()

  return () => {
    stopped = true
    snapshot = null
    unsubscribe()
    cancelScheduled?.()
    cancelScheduled = null
    if (refreshTimer !== null) {
      clearTimer(refreshTimer)
    }
  }
}
