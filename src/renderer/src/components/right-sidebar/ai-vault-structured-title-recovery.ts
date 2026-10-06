import {
  aiVaultSavedTitleIdentity,
  savedAiVaultTitleFromSnapshot,
  type AiVaultSavedTitle
} from './ai-vault-structured-title-projection'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import { getWebSessionTabsTrackingGeneration } from '@/runtime/web-session-tabs-sync/tracking-lifecycle'
import {
  localStructuredSessionGeneration,
  isCurrentLocalStructuredSessionGeneration
} from '@/runtime/local-structured-session-tabs-sync/inventory-generation-fence'
import type { AiVaultListResult } from '../../../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  AI_VAULT_SESSION_TITLE_REQUEST_MAX_COUNT,
  isAiVaultTitleAgent,
  type AiVaultSessionTitleRequest
} from '../../../../shared/ai-vault-session-title'
import { settleAiVaultTitleRequestBatches } from '@/lib/ai-vault-tab-title-batches'
import {
  cachedAiVaultStructuredSessions,
  publishAiVaultSavedTitles
} from './ai-vault-session-result-cache'

type RecoveryRequest = AiVaultSessionTitleRequest & { executionHostId: ExecutionHostId }
type PendingRecovery = { next: (() => boolean) | null; promise: Promise<void> }
const pendingByHost = new Map<ExecutionHostId, PendingRecovery>()

/** Finite repair at census/cache entry; ordinary tab and status updates never call this. */
export function recoverAiVaultStructuredTitles(
  executionHostId: ExecutionHostId,
  isCurrent: () => boolean
): Promise<void> {
  const sourceCurrent = isCurrent
  const parsed = parseExecutionHostId(executionHostId)
  const localGeneration = localStructuredSessionGeneration()
  const environmentId = parsed?.kind === 'runtime' ? parsed.environmentId : null
  const connection = environmentId
    ? getRuntimeEnvironmentConnectionGeneration(environmentId)
    : undefined
  const pairing = environmentId ? getRuntimeEnvironmentRevision(environmentId) : undefined
  const tracking = environmentId ? getWebSessionTabsTrackingGeneration(environmentId) : undefined
  isCurrent = () =>
    sourceCurrent() &&
    (environmentId
      ? getRuntimeEnvironmentConnectionGeneration(environmentId) === connection &&
        getRuntimeEnvironmentRevision(environmentId) === pairing &&
        getWebSessionTabsTrackingGeneration(environmentId) === tracking
      : executionHostId === 'local' && isCurrentLocalStructuredSessionGeneration(localGeneration))
  if (!isCurrent()) {
    return Promise.resolve()
  }
  const pending = pendingByHost.get(executionHostId)
  if (pending) {
    pending.next = isCurrent
    return pending.promise
  }
  const entry: PendingRecovery = { next: null, promise: Promise.resolve() }
  pendingByHost.set(executionHostId, entry)
  const run = async (): Promise<void> => {
    let current: (() => boolean) | null = isCurrent
    while (current) {
      const check = current
      entry.next = null
      const requests: RecoveryRequest[] = cachedAiVaultStructuredSessions(executionHostId).flatMap(
        (row) =>
          isAiVaultTitleAgent(row.agent) && row.structuredSession
            ? [
                {
                  executionHostId,
                  agent: row.agent,
                  sessionId: row.sessionId,
                  structuredSession: row.structuredSession
                }
              ]
            : []
      )
      const recovered: { title: AiVaultSavedTitle; providerSessionId: string }[] = []
      await settleAiVaultTitleRequestBatches(requests, async (batch) => {
        if (!check()) {
          return
        }
        const response = await window.api.aiVault.resolveSessionTitles({
          executionHostScope: executionHostId,
          requests: batch.map(({ executionHostId: _host, ...request }) => request)
        })
        if (!check()) {
          return
        }
        if (!Array.isArray(response.titles)) {
          return
        }
        for (const title of response.titles.slice(0, AI_VAULT_SESSION_TITLE_REQUEST_MAX_COUNT)) {
          const owner = title.structuredSession
          if (
            !owner ||
            !batch.some(
              (request) =>
                request.agent === title.agent &&
                request.sessionId === title.sessionId &&
                request.structuredSession?.workspaceId === owner.workspaceId &&
                request.structuredSession.sessionId === owner.sessionId
            )
          ) {
            continue
          }
          const saved = savedAiVaultTitleFromSnapshot(
            {
              worktree: owner.workspaceId,
              structuredConversationTitle: {
                sessionId: owner.sessionId,
                agent: title.agent,
                title: title.title
              }
            },
            executionHostId
          )
          if (saved) {
            recovered.push({ title: saved, providerSessionId: title.sessionId })
          }
        }
      })
      if (check()) {
        const currentOwners = new Set(
          cachedAiVaultStructuredSessions(executionHostId).flatMap((row) =>
            row.structuredSession
              ? [
                  JSON.stringify([
                    aiVaultSavedTitleIdentity({
                      executionHostId,
                      workspaceId: row.structuredSession.workspaceId,
                      agent: row.agent,
                      sessionId: row.structuredSession.sessionId
                    }),
                    row.sessionId
                  ])
                ]
              : []
          )
        )
        publishAiVaultSavedTitles(
          recovered
            .filter(({ title, providerSessionId }) =>
              currentOwners.has(
                JSON.stringify([aiVaultSavedTitleIdentity(title), providerSessionId])
              )
            )
            .map(({ title }) => title)
        )
      }
      current = entry.next
    }
  }
  entry.promise = run().finally(() => {
    if (pendingByHost.get(executionHostId) === entry) {
      pendingByHost.delete(executionHostId)
    }
  })
  return entry.promise
}

export function recoverLoadedAiVaultStructuredTitles(result: AiVaultListResult): void {
  const hosts = new Set(
    result.sessions.flatMap((row) => (row.structuredSession ? [row.executionHostId] : []))
  )
  for (const host of hosts) {
    void recoverAiVaultStructuredTitles(host, () => true)
  }
}
