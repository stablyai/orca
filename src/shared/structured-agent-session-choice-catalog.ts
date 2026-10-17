import type { AgentSessionChoiceCatalog, AgentSessionFastModeSupport } from './agent-session-wire'
import type { AgentSessionOptionCatalog } from './agent-session-option-catalog'
import type { StructuredAgentSessionOptionState } from './structured-agent-session-options'
import { discoveredModel } from './structured-agent-session-discovered-model'

/** Request time is charged conservatively; receiving a reply never renews its observation. */
export function ageStructuredAgentChoiceCatalog<T>(result: T, elapsedMs: number): T {
  if (typeof result !== 'object' || result === null || !('choiceCatalog' in result)) {
    return result
  }
  const catalog = result.choiceCatalog
  if (
    typeof catalog !== 'object' ||
    catalog === null ||
    !('freshForMs' in catalog) ||
    typeof catalog.freshForMs !== 'number'
  ) {
    return result
  }
  const freshForMs = Math.max(0, catalog.freshForMs - elapsedMs)
  return {
    ...result,
    choiceCatalog: { ...catalog, freshForMs, verifiedUntil: performance.now() + freshForMs }
  }
}

export function applyStructuredAgentChoiceCatalog(
  state: StructuredAgentSessionOptionState,
  seed: AgentSessionOptionCatalog,
  choice: AgentSessionChoiceCatalog,
  newLaunch = state.choiceCatalog?.newLaunch ?? false,
  runtime?: { fastModeSupport?: AgentSessionFastModeSupport }
): StructuredAgentSessionOptionState {
  const runtimeFastModeSupport = runtime
    ? runtime.fastModeSupport
    : state.choiceCatalog?.authority === 'session' &&
        (choice.authority !== 'session' || choice.scopeId !== state.choiceCatalog.scopeId)
      ? undefined
      : state.runtimeFastModeSupport
  const configured = newLaunch ? choice.configured : undefined
  const configuredRow = configured?.model
    ? choice.models.find(
        (row) => row.id === configured.model || row.resolvedModel === configured.model
      )
    : undefined
  const models = choice.models.map((row) =>
    discoveredModel(
      {
        ...row,
        isDefault: configured?.model ? row === configuredRow : row.isDefault,
        ...(configured?.effort &&
        (row === configuredRow || (!configured.model && row.isDefault)) &&
        row.efforts.some((effort) => effort.value === configured.effort)
          ? { defaultEffort: configured.effort }
          : {})
      },
      runtimeFastModeSupport?.supported !== false && choice.fastModeSupport?.supported === true
    )
  )
  if (configured?.model && !configuredRow) {
    models.push({ id: configured.model, label: configured.model, isDefault: true, options: [] })
  }
  return {
    ...state,
    runtimeFastModeSupport,
    choiceCatalog: {
      ...choice,
      newLaunch,
      verifiedUntil:
        'verifiedUntil' in choice && typeof choice.verifiedUntil === 'number'
          ? choice.verifiedUntil
          : performance.now() + Math.max(0, choice.freshForMs)
    },
    verifiedModelIds: undefined,
    hostListedModelIds: undefined,
    ...(models.length ||
    (state.record.model !== undefined &&
      (state.catalogSource === 'seed' || state.catalogSource === null))
      ? {
          catalog: {
            ...seed,
            models,
            defaultModelIsCliDefault:
              newLaunch && configured !== undefined ? (true as const) : undefined
          },
          catalogSource: choice.authority === 'session' ? ('live' as const) : ('host' as const)
        }
      : {})
  }
}

export function invalidateStructuredAgentChoiceCatalog(
  state: StructuredAgentSessionOptionState
): StructuredAgentSessionOptionState {
  return state.choiceCatalog
    ? {
        ...state,
        choiceCatalog: { ...state.choiceCatalog, complete: false, freshForMs: 0, verifiedUntil: 0 },
        runtimeFastModeSupport: undefined
      }
    : state
}
