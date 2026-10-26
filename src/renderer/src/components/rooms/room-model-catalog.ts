import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session-wire'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { LOCAL } from './room-types'

export type CatalogModel = {
  id: string
  label: string
  isDefault: boolean
  defaultEffort?: string
  efforts: { value: string; label: string }[]
}

export async function readAgentModels(agent: string, worktreeId: string): Promise<CatalogModel[]> {
  try {
    const result = await callStructuredAgentSession<AgentSessionModelCatalogResult>(
      LOCAL,
      'agentSession.modelCatalog',
      { agent, worktree: `id:${worktreeId}` }
    )
    return result.origin === 'unknown'
      ? []
      : result.models.map((m) => ({
          id: m.id,
          label: m.label,
          isDefault: m.isDefault,
          defaultEffort: m.defaultEffort,
          efforts: m.efforts.map((e) => ({ value: e.value, label: e.label }))
        }))
  } catch {
    return []
  }
}
