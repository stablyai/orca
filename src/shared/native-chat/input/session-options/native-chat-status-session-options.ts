import type { AgentProviderSessionMetadata } from '../../../agent-session/lifecycle/agent-session-resume'
import type {
  AgentSessionOptionCatalog,
  CatalogModel
} from '../../../agent-session/options/catalog-providers/agent-session-option-catalog-types'
import type { SessionOptionValue } from '../native-chat-session-options'
import { matchNativeChatCatalogModelId } from './native-chat-session-option-state'

export type NativeChatStatusSessionOptions = {
  values: Record<string, SessionOptionValue>
  /** Same agent session, model and effort: a repeat is not fresh evidence and must not revert a newer pick. */
  identity: string
}

/** What a terminal agent's status says its session runs: the model and, where that model offers
 *  it, the live effort. Desktop and phone chips both read it, so they show the same thing. */
export function readNativeChatStatusSessionOptions(
  agent: string,
  catalog: AgentSessionOptionCatalog,
  models: readonly CatalogModel[],
  status:
    | {
        model?: string
        providerSession?: Partial<Pick<AgentProviderSessionMetadata, 'id' | 'effort'>>
      }
    | undefined
): NativeChatStatusSessionOptions | null {
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
  const effortOption = models
    .find((candidate) => candidate.id === model)
    ?.options.find((option) => option.id === 'effort')
  const offersEffort =
    effort !== undefined &&
    effortOption?.kind.type === 'select' &&
    effortOption.kind.choices.some((choice) => choice.value === effort)
  const values: Record<string, SessionOptionValue> = offersEffort ? { model, effort } : { model }
  return {
    values,
    identity: JSON.stringify([
      agent,
      status.providerSession?.id ?? null,
      model,
      values.effort ?? null
    ])
  }
}
