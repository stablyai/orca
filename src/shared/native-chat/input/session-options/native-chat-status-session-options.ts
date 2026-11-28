import type { AgentProviderSessionMetadata } from '../../../agent-session/lifecycle/agent-session-resume'
import type {
  AgentSessionOptionCatalog,
  CatalogModel
} from '../../../agent-session/options/catalog-providers/agent-session-option-catalog-types'
import { setBoundedScopeCacheEntry } from '../composer/native-chat-scope-cache'
import type { SessionOptionValue } from '../native-chat-session-options'
import { matchNativeChatCatalogModelId } from './native-chat-session-option-state'

/** The model and effort facts a chip last applied, per terminal or tab. */
export type NativeChatStatusReportMemory = Map<string, { model: string; effort: string }>

/** Fresh facts to report, plus known ones that only describe a model the chip switches to. */
export type NativeChatStatusReport = {
  values: Record<string, SessionOptionValue>
  forNewModel?: Record<string, SessionOptionValue>
}

type ReportedStatus = {
  model?: string
  providerSession?: Partial<Pick<AgentProviderSessionMetadata, 'id' | 'effort'>>
}

/** What a terminal agent's status says its session runs: its model and live effort. Desktop and
 *  phone chips both read it. Model and effort are separate facts reported only when they change:
 *  hooks name Claude's model only at SessionStart and its Stop read but its effort on every tool
 *  hook, so resending an unchanged one would revert a newer pick. A new agent session reports both
 *  afresh. The chip checks each value against the model it lands on. */
export function takeNativeChatStatusReport(
  memory: NativeChatStatusReportMemory,
  scopeKey: string,
  agent: string,
  catalog: AgentSessionOptionCatalog,
  models: readonly CatalogModel[],
  status: ReportedStatus | undefined
): NativeChatStatusReport | null {
  const reportedModel = status?.model
  if (!reportedModel) {
    return null
  }
  // OMP reports exact selectors, including models absent from cached discovery.
  const model =
    agent === 'omp'
      ? reportedModel.trim()
      : matchNativeChatCatalogModelId({ ...catalog, models: [...models] }, reportedModel, {
          allowUnlisted: agent === 'codex'
        })
  if (!model) {
    return null
  }
  const effort = status.providerSession?.effort
  const sessionId = status.providerSession?.id ?? null
  const facts = {
    model: JSON.stringify([agent, sessionId, model]),
    effort: JSON.stringify([agent, sessionId, effort ?? null])
  }
  const applied = memory.get(scopeKey)
  const modelIsNew = applied?.model !== facts.model
  const effortIsNew = applied?.effort !== facts.effort
  if (!modelIsNew && !effortIsNew) {
    return null
  }
  setBoundedScopeCacheEntry(memory, scopeKey, facts)
  const known = effort !== undefined ? { effort } : undefined
  const fresh = effortIsNew ? known : undefined
  if (modelIsNew) {
    // An unchanged effort describes the model only if the chip switches to it.
    return { values: { model, ...fresh }, ...(known ? { forNewModel: known } : {}) }
  }
  return fresh ? { values: fresh } : null
}
