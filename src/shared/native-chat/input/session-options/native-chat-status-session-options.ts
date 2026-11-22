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

type ReportedStatus = {
  model?: string
  providerSession?: Partial<Pick<AgentProviderSessionMetadata, 'id' | 'effort'>>
}

/** What a terminal agent's status says its session runs, as values to report: the model, and the
 *  live effort where that model offers it. Desktop and phone chips both read it. Model and effort
 *  are separate facts: hooks name Claude's model only at SessionStart and its Stop read but its
 *  effort on every tool hook, so an unchanged model is not resent with a new effort, which would
 *  revert a newer model pick. A new agent session reports both afresh. */
export function takeNativeChatStatusReport(
  memory: NativeChatStatusReportMemory,
  scopeKey: string,
  agent: string,
  catalog: AgentSessionOptionCatalog,
  models: readonly CatalogModel[],
  status: ReportedStatus | undefined
): Record<string, SessionOptionValue> | null {
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
  const effort = offeredEffort(models, model, status.providerSession?.effort)
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
  if (modelIsNew) {
    return effort !== undefined ? { model, effort } : { model }
  }
  return effort !== undefined ? { effort } : null
}

function offeredEffort(
  models: readonly CatalogModel[],
  model: string,
  effort: string | undefined
): string | undefined {
  const option = models
    .find((candidate) => candidate.id === model)
    ?.options.find((candidate) => candidate.id === 'effort')
  return effort !== undefined &&
    option?.kind.type === 'select' &&
    option.kind.choices.some((choice) => choice.value === effort)
    ? effort
    : undefined
}
