import { useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import type { WorktreeRuntimeOwnerState } from '@/lib/worktree-runtime-owner-state'
import { runtimeRpcTargetForAuthorityKey } from '@/runtime/runtime-client-target'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { TerminalUsageLimitContinuationResult } from '../../../../shared/terminal-usage-limit-continuation'
import type { TerminalUsageLimitNotice } from './terminal-usage-limit-notice'

type Snapshot = { pending: boolean; result: TerminalUsageLimitContinuationResult | null }
type SourceCut = Omit<TerminalUsageLimitNotice, 'window' | 'resetsAt'>
type Attempt = {
  notice: SourceCut
  target: RuntimeClientTarget
  worktreeId?: string
  snapshot: Snapshot
}
const empty: Snapshot = { pending: false, result: null }
const attempts = new Map<string, Attempt>()
const listeners = new Map<string, Set<() => void>>()
let unsubscribeSource: (() => void) | undefined
const ownerInputs: (keyof WorktreeRuntimeOwnerState)[] = [
  'repos',
  'settings',
  'worktreesByRepo',
  'detectedWorktreesByRepo',
  'folderWorkspaces',
  'projectGroups',
  'restoredRuntimeHostIdByWorkspaceSessionKey',
  'activeWorktreeId',
  'activeWorkspaceExecutionHostId',
  'runtimeEnvironments',
  'runtimeEnvironmentCatalogHydrated',
  'removedRuntimeEnvironmentIds'
]
function hostKey(target: RuntimeClientTarget | null): string {
  return JSON.stringify(
    target?.kind === 'local' ? ['local'] : ['environment', target?.environmentId]
  )
}
export function usageLimitAttemptKey(
  target: RuntimeClientTarget,
  notice: TerminalUsageLimitNotice
): string {
  return JSON.stringify([hostKey(target), notice.terminal, notice.sessionId, notice.turnEndedAt])
}
function sourceKey(
  row: Pick<AgentStatusEntry, 'terminalHandle' | 'providerSession' | 'agentType' | 'connectionId'>
): string {
  return JSON.stringify([
    row.connectionId ?? null,
    row.terminalHandle,
    row.providerSession?.id,
    row.agentType
  ])
}
function retainsRoot(row: AgentStatusEntry, notice: SourceCut): boolean {
  return (
    !row.interrupted &&
    !row.sessionBoundary &&
    !row.restoredUnconfirmed &&
    !row.structuredHostOwned &&
    row.mainAgent?.state === 'done' &&
    row.mainAgent.outcome === 'failure' &&
    row.mainAgent.usageLimit !== undefined &&
    row.mainAgent.stateStartedAt === notice.mainStateStartedAt &&
    row.turnStartedAt === notice.turnStartedAt &&
    (row.state !== 'done' ||
      (row.turnEndedAt === notice.turnEndedAt && row.turnEndDisposition === 'identified'))
  )
}
function notify(key: string): void {
  listeners.get(key)?.forEach((listener) => listener())
}
function retire(key: string): void {
  attempts.delete(key)
  if (attempts.size === 0) {
    unsubscribeSource?.()
    unsubscribeSource = undefined
  }
  notify(key)
}
function observeSource(): void {
  if (unsubscribeSource) {
    return
  }
  unsubscribeSource = useAppStore.subscribe((state, previous) => {
    const sourceChanged = state.agentStatusByPaneKey !== previous.agentStatusByPaneKey
    const ownerChanged = ownerInputs.some((field) => state[field] !== previous[field])
    if (!sourceChanged && !ownerChanged) {
      return
    }
    const rows = new Map<string, AgentStatusEntry[]>()
    if (sourceChanged) {
      for (const row of Object.values(state.agentStatusByPaneKey)) {
        const key = sourceKey(row)
        const group = rows.get(key)
        if (group) {
          group.push(row)
        } else {
          rows.set(key, [row])
        }
      }
    }
    for (const [key, attempt] of attempts) {
      const { notice, worktreeId } = attempt
      const owner = worktreeId
        ? runtimeRpcTargetForAuthorityKey(getExecutionHostIdForWorktree(state, worktreeId))
        : attempt.target
      const sameOwner = hostKey(owner) === hostKey(attempt.target)
      const candidates = rows.get(
        sourceKey({
          terminalHandle: notice.terminal,
          providerSession: { id: notice.sessionId, key: 'session_id' },
          agentType: notice.agent,
          connectionId: notice.connectionId
        })
      )
      if (!sameOwner || (sourceChanged && !candidates?.some((row) => retainsRoot(row, notice)))) {
        retire(key)
      }
    }
  })
}
export function useUsageLimitAttempt(key: string): Snapshot {
  return useSyncExternalStore(
    (listener) => {
      let group = listeners.get(key)
      if (!group) {
        group = new Set()
        listeners.set(key, group)
      }
      group.add(listener)
      return () => {
        group.delete(listener)
        if (!group.size) {
          listeners.delete(key)
        }
      }
    },
    () => attempts.get(key)?.snapshot ?? empty,
    () => empty
  )
}
export async function attemptUsageLimitContinuation(
  target: RuntimeClientTarget,
  notice: TerminalUsageLimitNotice,
  worktreeId: string | undefined,
  dispatch: () => Promise<TerminalUsageLimitContinuationResult>
): Promise<void> {
  const key = usageLimitAttemptKey(target, notice)
  const current = attempts.get(key)?.snapshot
  if (current?.pending || (current?.result && current.result.status !== 'refused')) {
    return
  }
  const {
    agent,
    sessionId,
    turnEndedAt,
    terminal,
    connectionId,
    mainStateStartedAt,
    turnStartedAt
  } = notice
  const attempt: Attempt = {
    target,
    notice: {
      agent,
      sessionId,
      turnEndedAt,
      terminal,
      connectionId,
      mainStateStartedAt,
      turnStartedAt
    },
    worktreeId,
    snapshot: { pending: true, result: null }
  }
  attempts.set(key, attempt)
  observeSource()
  notify(key)
  let result: TerminalUsageLimitContinuationResult
  try {
    result = await dispatch()
  } catch {
    result = { status: 'unknown' }
  }
  // The old promise cannot recreate an operation its source already retired.
  if (attempts.get(key) !== attempt) {
    return
  }
  attempt.snapshot = { pending: false, result }
  notify(key)
}
