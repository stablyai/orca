import { usesModelSpecificAcpEfforts } from './agent-model-catalog-ownership'
import { discoveredModel } from './structured-agent-session-discovered-model'
import type { StructuredAgentSessionOptionState } from '../structured-agent-session-options'
import type { AgentSessionModelCatalogResult } from '../../agent-session-wire'
import type { AgentSessionModelOption } from './agent-session-model-option'
import type { CatalogModel } from '../catalog-providers/agent-session-option-catalog-types'

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
      chatEfforts: _unconfirmed,
      ...rest
    } = row
    return {
      ...rest,
      efforts: discovered.efforts,
      ...(discovered.chatEfforts ? { chatEfforts: discovered.chatEfforts } : {}),
      ...(discovered.defaultEffort !== undefined
        ? { defaultEffort: discovered.defaultEffort }
        : {}),
      ...(discovered.declaredDefaultEffort !== undefined
        ? { declaredDefaultEffort: discovered.declaredDefaultEffort }
        : {}),
      ...(rest.supportsFastMode === undefined && discovered.supportsFastMode !== undefined
        ? { supportsFastMode: discovered.supportsFastMode }
        : {}),
      ...(rest.defaultFastMode === undefined && discovered.defaultFastMode !== undefined
        ? { defaultFastMode: discovered.defaultFastMode }
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
  const listed = catalog.models.map((row) => discoveredModel(row, false, state.record.agent))
  const detailsById = new Map(listed.map((row) => [row.id, row.details]))
  const models = fillUnknownCatalogEfforts(state.catalog.models, listed).map((model) => {
    const listedDetails = detailsById.get(model.id)
    return listedDetails ? { ...model, details: { ...model.details, ...listedDetails } } : model
  })
  return {
    ...state,
    catalog: {
      ...state.catalog,
      models
    }
  }
}
