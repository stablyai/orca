import { shallow } from 'zustand/shallow'
import type { ModelCatalogSource } from '../../../../shared/agent-session/options/model-catalog-source'
import type {
  AgentPickerEntry,
  AgentPickerCatalogView
} from '../../../../shared/agent-launch/picker/agent-launch-picker'
import {
  agentPickerCatalogSources,
  agentPickerSourceView,
  withAgentPickerSourceView
} from '../../../../shared/agent-launch/picker/agent-launch-picker-source'

export type AgentPickerCatalogJob = { index: number; source: ModelCatalogSource }
export function agentPickerCatalogJobs(entries: AgentPickerEntry[]): AgentPickerCatalogJob[] {
  return entries.flatMap((entry, index) =>
    agentPickerCatalogSources(entry).flatMap((source) =>
      agentPickerSourceView(entry, source).catalogRead === 'unsupported' ? [] : [{ index, source }]
    )
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
  patch: Partial<AgentPickerCatalogView>
) {
  const entry = entries[job.index]
  const before = agentPickerSourceView(entry, job.source)
  const next = { ...before, ...patch }
  return shallow(before, next)
    ? entries
    : entries.map((row, index) =>
        index === job.index ? withAgentPickerSourceView(row, job.source, next) : row
      )
}
export { agentPickerSourceView }

export function withAgentPickerCatalogAvailability(
  entry: AgentPickerEntry,
  available: Record<ModelCatalogSource, boolean>,
  registeredAgents?: readonly { agent: string }[] | null
) {
  for (const source of agentPickerCatalogSources(entry)) {
    entry = withAgentPickerSourceView(entry, source, {
      ...agentPickerSourceView(entry, source),
      catalogRead:
        available[source] &&
        (source !== 'structured' ||
          !registeredAgents ||
          registeredAgents.some(({ agent }) => agent === entry.agent))
          ? 'pending'
          : 'unsupported'
    })
  }
  return entry
}
