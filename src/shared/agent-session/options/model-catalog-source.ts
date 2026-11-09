import type { AgentChoicePatch } from '../../agent-launch/choices/agent-launch-choices'
import type { AgentSessionModelOption } from '../agent-session-wire'

export type ModelCatalogSource = 'structured' | 'cli'
export type ModelCatalogSurface = 'chat' | 'terminal' | 'textGeneration'

const sources: Readonly<Record<string, Partial<Record<ModelCatalogSurface, ModelCatalogSource>>>> =
  {
    antigravity: { terminal: 'cli' }
  }

export function modelCatalogSource(
  agent: string,
  surface: ModelCatalogSurface
): ModelCatalogSource {
  return sources[agent]?.[surface] ?? 'structured'
}

/** Only an explicit replacement may clear menu-owned options the new source row cannot express. */
export function modelCatalogChoiceEdit(
  source: ModelCatalogSource,
  rows: readonly AgentSessionModelOption[],
  currentModel: string | undefined,
  patch: AgentChoicePatch
): AgentChoicePatch {
  return source === 'cli' &&
    patch.model &&
    patch.model !== currentModel &&
    rows.some((row) => row.id === patch.model && row.efforts.length === 0)
    ? { ...patch, options: { ...patch.options, effort: null } }
    : patch
}
