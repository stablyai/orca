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
    if (row.effortsKnown !== false || !discovered || discovered.effortsKnown === false) {
      return row
    }
    const {
      effortsKnown: _unknown,
      defaultEffort: _default,
      declaredDefaultEffort: _declared,
      ...rest
    } = row
    return {
      ...rest,
      efforts: discovered.efforts,
      ...(discovered.defaultEffort !== undefined
        ? { defaultEffort: discovered.defaultEffort }
        : {}),
      ...(discovered.declaredDefaultEffort !== undefined
        ? { declaredDefaultEffort: discovered.declaredDefaultEffort }
        : {}),
      ...(rest.supportsFastMode === undefined && discovered.supportsFastMode !== undefined
        ? { supportsFastMode: discovered.supportsFastMode }
        : {})
    }
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
    return {
      ...rest,
      ...(discovered.declaredDefaultEffort !== undefined
        ? { declaredDefaultEffort: discovered.declaredDefaultEffort }
        : {}),
      options: [
        ...row.options.filter((option) => option.id !== 'effort'),
        ...discovered.options.filter((option) => option.id === 'effort')
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
        catalog.models.map((row) => discoveredModel(row, false, state.record.agent))
      )
    }
  }
}
