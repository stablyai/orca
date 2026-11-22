import { getAgentSessionOptionCatalog } from '../../../agent-session/options/agent-session-option-catalog'
import type { CatalogModel } from '../../../agent-session/options/catalog-providers/agent-session-option-catalog-types'
import type { AgentType } from '../../../agent-status/contracts/agent-status-types'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface,
  SessionOptionValue,
  SessionOptionValueSource
} from '../native-chat-session-options'
import { recordNativeChatSessionOptionCommand } from './native-chat-session-option-commands'
import {
  applyNativeChatReportedSessionOptions,
  clearNativeChatSessionModel,
  createNativeChatSessionOptionRecord,
  setTrackedSessionOption,
  type NativeChatSessionOptionRecord
} from './native-chat-session-option-state'
import {
  readNativeChatSessionOptionCache,
  writeNativeChatSessionOptionCache
} from './native-chat-session-option-cache'
import { createSessionOptionAppliers } from './native-chat-session-option-apply'
import {
  buildNativeChatSessionOptionSnapshot,
  resolveEffectiveNativeChatModelId,
  withTrackedNativeChatModel,
  type NativeChatSessionOptionMode
} from './native-chat-session-option-snapshot'
import type { NativeChatSessionOptionDispatchCommand } from './native-chat-session-option-dispatch'

type PersistSelection = (args: {
  modelId: string
  optionId: string
  value: SessionOptionValue
  /** False leaves the model scoping this value only, never a persisted launch flag. */
  adoptModelAsLaunchDefault: boolean
}) => Promise<void> | void

export type NativeChatPtySessionOptionsSurface = SessionOptionsSurface & {
  recordOutgoingCommand(command: string): void
  /** Applies what the running agent reports. `forNewModel` holds values that are not news on their
   *  own (an unchanged effort) but describe a model the session switches to. */
  reportSessionOptions(
    values: Record<string, SessionOptionValue>,
    forNewModel?: Record<string, SessionOptionValue>
  ): void
  replaceModels(models: CatalogModel[]): void
  /** The context window the host's model listing states for `modelId`, or null. */
  contextWindowTokens(modelId: string): number | null
}

export type CreateNativeChatPtySessionOptionsArgs = {
  agent: AgentType
  scopeKey: string
  fallbackScopeKey?: string
  initialModels?: readonly CatalogModel[]
  mode: NativeChatSessionOptionMode
  /** The model row's name in the reader's language. */
  modelLabel: string
  canSwitchOmpModel?: boolean
  dispatchCommand: NativeChatSessionOptionDispatchCommand
  onAgentPicker?: () => void
  persistSelection?: PersistSelection
  onDraftValuesChanged?: (values: Record<string, SessionOptionValue>) => void
}

export function createNativeChatPtySessionOptions(
  args: CreateNativeChatPtySessionOptionsArgs
): NativeChatPtySessionOptionsSurface | null {
  const baseCatalog = getAgentSessionOptionCatalog(args.agent)
  if (!baseCatalog) {
    return null
  }
  const catalog =
    args.agent === 'omp' && args.mode === 'live' && !args.canSwitchOmpModel
      ? { ...baseCatalog, modelApply: { ...baseCatalog.modelApply, midSession: undefined } }
      : baseCatalog
  let models = [...(args.initialModels ?? catalog.models)]
  // Cached enrichment contains probe results, so its default is authoritative rather than a seed guess.
  let modelsAreDiscovered = args.initialModels !== undefined
  let record =
    readNativeChatSessionOptionCache(args.scopeKey, args.fallbackScopeKey) ??
    createNativeChatSessionOptionRecord(args.agent)
  if (record.agent !== args.agent) {
    record = createNativeChatSessionOptionRecord(args.agent)
  }

  const activeModels = (): CatalogModel[] => withTrackedNativeChatModel(catalog, models, record)
  let snapshot = buildNativeChatSessionOptionSnapshot({
    catalog,
    models: activeModels(),
    legacyInventory: models,
    record,
    mode: args.mode,
    modelLabel: args.modelLabel,
    liveTransport: 'catalog'
  })
  const listeners = new Set<(value: SessionOptionDescriptor[]) => void>()

  const publish = (): SessionOptionDescriptor[] => {
    writeNativeChatSessionOptionCache(args.scopeKey, record)
    snapshot = buildNativeChatSessionOptionSnapshot({
      catalog,
      models: activeModels(),
      legacyInventory: models,
      record,
      mode: args.mode,
      modelLabel: args.modelLabel,
      liveTransport: 'catalog'
    })
    for (const listener of listeners) {
      listener(snapshot)
    }
    return snapshot
  }

  const clearModelTruth = (): void => {
    clearNativeChatSessionModel(record)
  }

  /** Resolve at commit so discovery replaces untracked seed guesses with the model the CLI actually used. */
  const setTrackedValue = (
    optionId: string,
    value: SessionOptionValue,
    source: 'applied' | 'dispatched'
  ): string | null =>
    setTrackedSessionOption(
      record,
      optionId,
      value,
      source,
      resolveEffectiveNativeChatModelId(catalog, activeModels(), record)
    )

  /** Persist only listed, selected or discovered ids; authoritative omissions prove retirement. Recheck after awaits to avoid fatal -m flags. */
  const modelIsAdoptableAsLaunchDefault = (modelId: string): boolean => {
    const listedIn = (list: readonly CatalogModel[]): boolean =>
      list.some((model) => model.id === modelId)
    if (!listedIn(models) && !listedIn(catalog.models)) {
      return false
    }
    return modelsAreDiscovered
      ? !catalog.discoveredModelsAreAuthoritative || listedIn(models)
      : record.model !== undefined
  }

  const persist = (modelId: string | null, optionId: string, value: SessionOptionValue): void => {
    if (modelId) {
      void args.persistSelection?.({
        modelId,
        optionId,
        value,
        adoptModelAsLaunchDefault: modelIsAdoptableAsLaunchDefault(modelId)
      })
    }
  }

  const appliers = createSessionOptionAppliers({
    mode: args.mode,
    catalog,
    getModels: activeModels,
    getRecord: () => record,
    dispatchCommand: args.dispatchCommand,
    onAgentPicker: args.onAgentPicker,
    persist,
    onDraftValuesChanged: args.onDraftValuesChanged,
    publish,
    clearModelTruth,
    setTrackedValue
  })

  return {
    getSnapshot: () => snapshot,
    setOption: appliers.setOption,
    invokeAction: appliers.invokeAction,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    recordOutgoingCommand: (command) => {
      const result = recordNativeChatSessionOptionCommand({
        catalog,
        models: activeModels(),
        record,
        command,
        persist
      })
      if (result.changed) {
        publish()
      }
      if (result.opensAgentPicker) {
        args.onAgentPicker?.()
      }
    },
    reportSessionOptions: (values, forNewModel) => {
      const targetModel = typeof values.model === 'string' ? values.model : record.model?.value
      const reported = { ...carriedValues(record, values, forNewModel), ...values }
      const offered = offeredValues(activeModels(), targetModel, reported)
      if (applyNativeChatReportedSessionOptions(record, offered)) {
        publish()
      }
    },
    replaceModels: (nextModels) => {
      models = [...nextModels]
      modelsAreDiscovered = true
      publish()
    },
    contextWindowTokens: (modelId) =>
      models.find((model) => model.id === modelId)?.contextWindowTokens ?? null
  }
}

/** Known values describe the reported model where the session switches to it, or where it already
 *  runs it (a chip pick just confirmed) without a value the user chose. */
function carriedValues(
  record: NativeChatSessionOptionRecord,
  values: Record<string, SessionOptionValue>,
  forNewModel: Record<string, SessionOptionValue> | undefined
): Record<string, SessionOptionValue> {
  if (!forNewModel || typeof values.model !== 'string') {
    return {}
  }
  const switches = values.model !== record.model?.value
  const tracked = record.valuesByModel[values.model]
  return Object.fromEntries(
    Object.entries(forNewModel).filter(([id]) => switches || !isUserChoice(tracked?.[id]?.source))
  )
}

function isUserChoice(source: SessionOptionValueSource | undefined): boolean {
  return source === 'applied' || source === 'dispatched'
}

/** Keeps the reported values the receiving model offers; a hook can name a model the user already
 *  switched away from, so values are checked against the model they land on. */
function offeredValues(
  models: readonly CatalogModel[],
  modelId: SessionOptionValue | undefined,
  values: Record<string, SessionOptionValue>
): Record<string, SessionOptionValue> {
  const options = models.find((model) => model.id === modelId)?.options ?? []
  return Object.fromEntries(
    Object.entries(values).filter(([id, value]) => {
      if (id === 'model') {
        return true
      }
      const kind = options.find((option) => option.id === id)?.kind
      return kind?.type === 'select'
        ? kind.choices.some((choice) => choice.value === value)
        : kind?.type === 'boolean' && typeof value === 'boolean'
    })
  )
}
