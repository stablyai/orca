import { shallow } from 'zustand/shallow'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'

export type AgentPickerCatalogJob = { index: number }
export function agentPickerCatalogJobs(entries: AgentPickerEntry[]): AgentPickerCatalogJob[] {
  return entries.flatMap((entry, index) =>
    entry.surfaces.length && entry.catalogRead !== 'unsupported' ? [{ index }] : []
  )
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
  const next = { ...before, ...patch }
  return shallow(before, next)
    ? entries
    : entries.map((row, index) => (index === job.index ? next : row))
}
