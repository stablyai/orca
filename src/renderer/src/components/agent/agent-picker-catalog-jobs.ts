import { shallow } from 'zustand/shallow'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'

export type AgentPickerCatalogJob = { index: number; surface?: 'terminal'; pending?: boolean }
export function agentPickerCatalogJobs(entries: AgentPickerEntry[]): AgentPickerCatalogJob[] {
  return entries.flatMap((entry, index) => [
    ...(entry.surfaces.length &&
    entry.catalogRead !== 'unsupported' &&
    (entry.agent !== 'antigravity' || entry.surfaces.includes('chat'))
      ? [{ index }]
      : []),
    ...(entry.agent === 'antigravity' && entry.surfaces.includes('terminal')
      ? [{ index, surface: 'terminal' as const }]
      : [])
  ])
}
export function agentPickerCatalogFailure(error: unknown): 'unsupported' | 'failed' {
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
  const next = {
    ...before,
    ...(job.surface === 'terminal'
      ? {
          ...(patch.catalog ? { terminalCatalog: patch.catalog } : {}),
          ...(patch.catalogRead ? { terminalCatalogRead: patch.catalogRead } : {})
        }
      : patch)
  }
  return shallow(before, next)
    ? entries
    : entries.map((row, index) => (index === job.index ? next : row))
}

export function agentPickerCatalogView(entry: AgentPickerEntry, job: AgentPickerCatalogJob) {
  return job.surface === 'terminal'
    ? {
        catalog: entry.terminalCatalog ?? { origin: 'unknown' as const },
        catalogRead: entry.terminalCatalogRead
      }
    : entry
}

export function prepareAgentPickerCatalogDemand(
  entries: AgentPickerEntry[],
  jobs: AgentPickerCatalogJob[],
  queued: Set<number>
): AgentPickerEntry[] {
  for (const [index, job] of jobs.entries()) {
    if (
      job.surface === 'terminal' &&
      agentPickerCatalogView(entries[job.index], job).catalogRead !== 'pending'
    ) {
      queued.add(index)
      entries = updateAgentPickerCatalog(entries, job, { catalog: { origin: 'unknown' } })
    }
    if (queued.has(index)) {
      entries = updateAgentPickerCatalog(entries, job, { catalogRead: 'pending' })
    }
  }
  return entries
}

export function invalidateAgentPickerCatalogJobs(input: {
  entries: AgentPickerEntry[]
  jobs: AgentPickerCatalogJob[]
  refreshOnInvalidation?: (entry: AgentPickerEntry) => boolean
  queued: Record<'catalog' | 'refresh', Set<number>>
}) {
  let entries = input.entries
  const jobs = input.jobs.map((job, index) => {
    if (input.refreshOnInvalidation?.(entries[job.index]) === false) {
      return job
    }
    input.queued.refresh.delete(index)
    entries = updateAgentPickerCatalog(entries, job, {
      catalog: { origin: 'unknown' },
      catalogRead: 'pending'
    })
    input.queued.catalog.add(index)
    return { ...job }
  })
  return { entries, jobs }
}
