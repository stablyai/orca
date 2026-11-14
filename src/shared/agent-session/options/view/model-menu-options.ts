import type {
  AgentSessionModelCatalogResult,
  AgentSessionModelOption
} from '../../agent-session-wire'
import type { AgentSessionOptionCatalog } from '../catalog-providers/agent-session-option-catalog-types'
import {
  applyStructuredAgentSessionModelCatalog,
  commitStructuredAgentSessionOptionValues,
  createStructuredAgentSessionOptionState,
  settleStructuredAgentSessionBuiltinCatalog
} from '../structured-agent-session-options'
import { structuredAgentSessionShownSnapshot } from './structured-agent-session-option-view'
import { withoutUnprovenNewLaunchDefault } from '../model-catalog/host-model-catalog-snapshot-rules'

export type ModelMenuSurface = 'chat' | 'terminal' | 'textGeneration'
export type ModelMenuInput = {
  agent: string
  surface: ModelMenuSurface
  seed: AgentSessionOptionCatalog
  saved?: Readonly<Record<string, string>>
  pending?: boolean
  coherentCatalog?: boolean
  newLaunch: boolean
  seedsModel: boolean
}

/** Membership and display follow the composer; carriers remain owned by each launch surface. */
export function modelMenuOptions(
  answer: AgentSessionModelCatalogResult | undefined,
  input: ModelMenuInput
) {
  let state = createStructuredAgentSessionOptionState(input.agent, input.seed)
  const catalog =
    answer && input.newLaunch && !input.seedsModel
      ? withoutUnprovenNewLaunchDefault(answer)
      : answer
  const observed =
    catalog?.origin === 'unknown' && input.pending
      ? { ...catalog, listingInProgress: true as const }
      : catalog
  const surfaced =
    observed?.origin !== 'unknown' && observed
      ? {
          ...observed,
          models: observed.models.map((model) =>
            input.surface === 'chat' ? model : { ...model, chatEfforts: undefined }
          )
        }
      : observed
  state = surfaced
    ? applyStructuredAgentSessionModelCatalog(state, input.seed, surfaced, input)
    : settleStructuredAgentSessionBuiltinCatalog(
        state,
        input.pending === true || catalog?.listingInProgress === true
      )
  // Config default is an execution mode (omit --model), rather than a model-list entry.
  const configDefault =
    input.agent === 'pi' || input.agent === 'opencode2'
      ? input.seed.models.find((model) => model.id === 'default')
      : undefined
  if (
    configDefault &&
    state.catalogSource === 'host' &&
    state.catalog &&
    !state.catalog.models.some((model) => model.id === 'default')
  ) {
    state = {
      ...state,
      catalog: { ...state.catalog, models: [configDefault, ...state.catalog.models] }
    }
  }
  state = commitStructuredAgentSessionOptionValues(state, input.saved ?? {})
  const status =
    state.catalogSource === 'seed'
      ? 'listing'
      : state.catalogSource === 'builtin'
        ? 'builtin'
        : 'listed'
  const liveById = new Map<string, AgentSessionModelOption>()
  if (surfaced?.origin !== 'unknown') {
    for (const row of surfaced?.models ?? []) {
      if (!liveById.has(row.id)) {
        liveById.set(row.id, row)
      }
    }
  }
  const rows: AgentSessionModelOption[] =
    status === 'listing'
      ? []
      : (state.catalog?.models ?? []).map((model) => {
          const live = liveById.get(model.id)
          const effort = model.options.find((option) => option.id === 'effort')?.kind
          return (
            live ?? {
              id: model.id,
              label: model.label,
              description: model.description,
              isDefault: model.isDefault === true,
              efforts: effort?.type === 'select' ? effort.choices : [],
              ...(effort?.type === 'select' ? { defaultEffort: effort.defaultValue } : {})
            }
          )
        })
  const savedModel = input.saved?.model
  const descriptors = structuredAgentSessionShownSnapshot(state).map((descriptor) =>
    descriptor.id === 'model' &&
    descriptor.kind.type === 'select' &&
    savedModel &&
    !rows.some((row) => row.id === savedModel)
      ? {
          ...descriptor,
          kind: {
            ...descriptor.kind,
            choices: descriptor.kind.choices.map((choice) =>
              choice.value === savedModel ? { ...choice, label: savedModel } : choice
            )
          }
        }
      : descriptor
  )
  return { status, rows, catalog: state.catalog, descriptors }
}
