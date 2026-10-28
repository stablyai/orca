import { getAgentSessionOptionCatalog, type CatalogModel } from './agent-session-option-catalog'
import type { AgentType } from './agent-status-types'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface,
  SessionOptionValue
} from './native-chat/input/native-chat-session-options'
import { recordNativeChatSessionOptionCommand } from './native-chat/input/native-chat-session-option-commands'
import {
  applyNativeChatReportedSessionOptions,
  clearNativeChatSessionModel,
  createNativeChatSessionOptionRecord,
  setTrackedSessionOption
} from './native-chat/input/native-chat-session-option-state'
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
} from './native-chat/input/native-chat-session-option-snapshot'
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
  reportSessionOptions(values: Record<string, SessionOptionValue>): void
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
  reportedValues?: Record<string, SessionOptionValue> | null
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

  if (args.reportedValues && applyNativeChatReportedSessionOptions(record, args.reportedValues)) {
    writeNativeChatSessionOptionCache(args.scopeKey, record)
  }
  /** Untrack probe-retired ids so reinjection and later option writes cannot restore fatal launch flags. */
  const untrackRetiredModel = (): boolean => {
    if (!catalog.discoveredModelsAreAuthoritative || !modelsAreDiscovered) {
      return false
    }
    const trackedId = typeof record.model?.value === 'string' ? record.model.value : null
    if (!trackedId || models.some((model) => model.id === trackedId)) {
      return false
    }
    clearNativeChatSessionModel(record)
    return true
  }
  if (untrackRetiredModel()) {
    writeNativeChatSessionOptionCache(args.scopeKey, record)
  }
  const activeModels = (): CatalogModel[] => withTrackedNativeChatModel(catalog, models, record)
  let snapshot = buildNativeChatSessionOptionSnapshot({
    catalog,
    models: activeModels(),
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
    reportSessionOptions: (values) => {
      if (applyNativeChatReportedSessionOptions(record, values)) {
        publish()
      }
    },
    replaceModels: (nextModels) => {
      models = [...nextModels]
      modelsAreDiscovered = true
      untrackRetiredModel()
      publish()
    },
    contextWindowTokens: (modelId) =>
      models.find((model) => model.id === modelId)?.contextWindowTokens ?? null
  }
}
