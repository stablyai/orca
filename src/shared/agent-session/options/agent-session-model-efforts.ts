import { usesModelSpecificAcpEfforts } from './agent-model-catalog-ownership'
import { discoveredModel } from './structured-agent-session-discovered-model'
import type { StructuredAgentSessionOptionState } from './structured-agent-session-options'
import type { AgentSessionModelCatalogResult, AgentSessionModelOption } from '../agent-session-wire'
import type { CatalogModel } from './agent-session-option-catalog-types'

/** An unobserved menu cannot erase capabilities learned for the same model. */
export function fillUnknownModelEfforts(
  models: AgentSessionModelOption[],
  known: readonly AgentSessionModelOption[]
): AgentSessionModelOption[] {
  const byId = new Map(known.map((row) => [row.id, row]))
  return models.map((row) => {
    const discovered = byId.get(row.id)
    const withFast = (model: AgentSessionModelOption): AgentSessionModelOption =>
      model.supportsFastMode === undefined && discovered?.supportsFastMode !== undefined
        ? { ...model, supportsFastMode: discovered.supportsFastMode }
        : model
    if (row.effortsKnown !== false || !discovered || discovered.effortsKnown === false) {
      return withFast(row)
    }
    const {
      effortsKnown: _unknown,
      defaultEffort: _default,
      declaredDefaultEffort: _declared,
      ...rest
    } = row
    return withFast({
      ...rest,
      efforts: discovered.efforts,
      ...(discovered.defaultEffort !== undefined
        ? { defaultEffort: discovered.defaultEffort }
        : {}),
      ...(discovered.declaredDefaultEffort !== undefined
        ? { declaredDefaultEffort: discovered.declaredDefaultEffort }
        : {})
    })
  })
}

export function fillUnknownCatalogEfforts(
  models: CatalogModel[],
  known: readonly CatalogModel[]
): CatalogModel[] {
  const byId = new Map(known.map((row) => [row.id, row]))
  return models.map((row) => {
    const discovered = byId.get(row.id)
    if (row.effortsKnown !== false || !discovered || discovered.effortsKnown === false) {
      return row
    }
    const { effortsKnown: _unknown, declaredDefaultEffort: _declared, ...rest } = row
    const fast = discovered.options.filter((option) => option.id === 'fastMode')
    return {
      ...rest,
      ...(discovered.declaredDefaultEffort !== undefined
        ? { declaredDefaultEffort: discovered.declaredDefaultEffort }
        : {}),
      options: [
        ...row.options.filter(
          (option) => option.id !== 'effort' && (fast.length === 0 || option.id !== 'fastMode')
        ),
        ...discovered.options.filter((option) => option.id === 'effort'),
        ...fast
      ]
    }
  })
}

export function enrichStructuredAgentEfforts(
  state: StructuredAgentSessionOptionState,
  catalog: AgentSessionModelCatalogResult
): StructuredAgentSessionOptionState {
  if (
    !usesModelSpecificAcpEfforts(state.record.agent) ||
    !state.catalog ||
    catalog.origin === 'unknown'
  ) {
    return state
  }
  return {
    ...state,
    catalog: {
      ...state.catalog,
      models: fillUnknownCatalogEfforts(
        state.catalog.models,
        catalog.models.map((row) =>
          discoveredModel(row, catalog.fastModeSupport?.supported === true, state.record.agent)
        )
      )
    }
  }
}
