import { shallow } from 'zustand/shallow'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'
import { readAgentSessionErrorRefusal } from '../../../../shared/agent-session/failures/agent-session-write-failure'
import {
  isRecoverableRemoteRuntimeConnectionError,
  isRuntimeRpcQueueOverloadError,
  toRemoteRuntimeClientErrorLike
} from '../../../../shared/remote-runtime/remote-runtime-client-error-classification'

/** `relist`: a Refresh the next read must carry, kept until a read with it answers. */
export type AgentPickerCatalogJob = { index: number; relist?: true }
export function agentPickerCatalogJobs(entries: AgentPickerEntry[]): AgentPickerCatalogJob[] {
  return entries.flatMap((entry, index) =>
    entry.surfaces.length && entry.catalogRead !== 'unsupported' ? [{ index }] : []
  )
}
// Only contact lost or being re-established retries; a timeout or a busy client fails fast.
function agentPickerCatalogReconnecting(error: unknown): boolean {
  const like = toRemoteRuntimeClientErrorLike(error)
  const message = like.message.toLowerCase()
  return (
    isRecoverableRemoteRuntimeConnectionError(like) &&
    !isRuntimeRpcQueueOverloadError(like) &&
    (like.code === undefined
      ? !/timed out|limit reached/.test(message)
      : !['runtime_timeout', 'timeout', 'remote_runtime_busy'].includes(like.code))
  )
}
export function agentPickerCatalogFailure(error: unknown): 'unsupported' | 'failed' | 'retry' {
  // Why: hosts before 1.4.248 refuse a session-less catalog read until something starts their
  // chat host, so that refusal is retryable, not final.
  const refusal = readAgentSessionErrorRefusal(error)
  if (
    refusal?.code === 'structured_agent_session_unsupported' &&
    refusal.details?.reason === 'hostDisabled'
  ) {
    return 'retry'
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'method_not_found' ||
      error.code === 'structured_agent_session_unsupported' ||
      error.code === 'forbidden')
  ) {
    return 'unsupported'
  }
  return agentPickerCatalogReconnecting(error) ? 'retry' : 'failed'
}
export function updateAgentPickerCatalog(
  entries: AgentPickerEntry[],
  job: AgentPickerCatalogJob,
  patch: Partial<Pick<AgentPickerEntry, 'catalog' | 'catalogRead'>>
) {
  const before = entries[job.index]
  const next = { ...before, ...patch }
  return shallow(before, next)
    ? entries
    : entries.map((row, index) => (index === job.index ? next : row))
}

// Transient failures (an older host still starting its chat host, a dropped bridge) recover
// within seconds; a few spaced retries keep an open picker from settling on built-in models.
export const AGENT_PICKER_CATALOG_RETRY_DELAYS_MS = [1_000, 3_000, 10_000] as const

/** Bounded retries per job; a new job (reopen or invalidation) starts over. */
export class AgentPickerCatalogRetries {
  private attempts = new WeakMap<AgentPickerCatalogJob, number>()
  private timers = new Set<ReturnType<typeof setTimeout>>()

  schedule(job: AgentPickerCatalogJob, retry: () => void): boolean {
    const attempt = this.attempts.get(job) ?? 0
    if (attempt >= AGENT_PICKER_CATALOG_RETRY_DELAYS_MS.length) {
      return false
    }
    this.attempts.set(job, attempt + 1)
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      retry()
    }, AGENT_PICKER_CATALOG_RETRY_DELAYS_MS[attempt])
    this.timers.add(timer)
    return true
  }

  /** What a failed read shows: still pending while a transient failure waits for its retry. */
  failed(
    error: unknown,
    job: AgentPickerCatalogJob,
    open: boolean,
    retry: () => void
  ): 'pending' | 'unsupported' | 'failed' {
    const failure = agentPickerCatalogFailure(error)
    if (failure !== 'retry') {
      return failure
    }
    return open && this.schedule(job, retry) ? 'pending' : 'failed'
  }

  cancel() {
    this.timers.forEach(clearTimeout)
    this.timers.clear()
  }
}
