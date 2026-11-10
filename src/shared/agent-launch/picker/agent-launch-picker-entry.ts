import type { AgentSessionModelCatalogResult } from '../../agent-session/agent-session-wire'
import type { ModelCatalogSource } from '../../agent-session/options/model-catalog-source'
import type { AgentDedicatedChoices } from '../choices/agent-launch-choices'
import type { TuiAgent } from '../catalog/tui-agent'
import type { TextActionPickerCatalog } from './agent-launch-picker-text-action'
import type { NewTabAgentMenuRow } from './agent-launch-picker-rows'
import type { AgentPickerSurface } from './agent-launch-picker'

export type AgentPickerCatalogView = {
  catalog: AgentSessionModelCatalogResult
  coherentCatalog?: boolean
  catalogRead?: 'pending' | 'settled' | 'failed' | 'unsupported'
}
export type AgentPickerEntry = AgentPickerCatalogView & {
  sourceCatalogs?: Partial<Record<ModelCatalogSource, AgentPickerCatalogView>>
  textGeneration?: TextActionPickerCatalog
  agent: TuiAgent
  label: string
  description?: string
  aliases?: string[]
  rows: NewTabAgentMenuRow[]
  surfaces: AgentPickerSurface[]
  defaultSurface: AgentPickerSurface
  terminal: AgentDedicatedChoices
  structured: AgentDedicatedChoices
  arguments?: string | null
  ownerKey?: string
  draftTarget?: { key: string; worktreeId?: string; repoId?: string; executionHostId: string }
  /** The workspace the agent launches in, whose files and skills its first prompt can name. */
  worktreeId?: string
  defaultsPending?: boolean
  structuredDefaultsPending?: boolean
}
