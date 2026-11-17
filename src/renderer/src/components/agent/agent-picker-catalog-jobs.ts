import { shallow } from 'zustand/shallow'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'
import { readAgentSessionErrorRefusal } from '../../../../shared/agent-session/failures/agent-session-write-failure'

export type AgentPickerCatalogJob = { index: number }
export function agentPickerCatalogJobs(entries: AgentPickerEntry[]): AgentPickerCatalogJob[] {
  return entries.flatMap((entry, index) =>
    entry.surfaces.length && entry.catalogRead !== 'unsupported' ? [{ index }] : []
  )
}
export function agentPickerCatalogFailure(error: unknown): 'unsupported' | 'failed' {
  // Why: hosts before 1.4.248 refuse a session-less catalog read until something starts their
  // chat host, so that refusal is retryable, not final.
  const refusal = readAgentSessionErrorRefusal(error)
  if (
    refusal?.code === 'structured_agent_session_unsupported' &&
    refusal.details?.reason === 'hostDisabled'
  ) {
    return 'failed'
  }
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'method_not_found' ||
      error.code === 'structured_agent_session_unsupported' ||
      error.code === 'forbidden')
    ? 'unsupported'
    : 'failed'
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

  cancel() {
    this.timers.forEach(clearTimeout)
    this.timers.clear()
  }
}
