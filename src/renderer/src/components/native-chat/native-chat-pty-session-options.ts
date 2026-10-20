import {
  getAgentSessionOptionCatalog,
  type CatalogModel
} from '../../../../shared/agent-session-option-catalog'
import type { AgentType } from '../../../../shared/agent-status-types'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface,
  SessionOptionValue
} from '../../../../shared/native-chat-session-options'
import { recordNativeChatSessionOptionCommand } from '../../../../shared/native-chat-session-option-commands'
import {
  applyNativeChatReportedSessionOptions,
  clearNativeChatSessionModel,
  cloneDefaultModel,
  createNativeChatSessionOptionRecord,
  setTrackedSessionOption
} from '../../../../shared/native-chat-session-option-state'
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
import type { NativeChatSessionOptionDispatchCommand } from './native-chat-session-option-command-dispatch'

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
  canSwitchOmpModel?: boolean
  reportedValues?: Record<string, SessionOptionValue> | null
  dispatchCommand: NativeChatSessionOptionDispatchCommand
  onAgentPicker?: () => void
  refreshModels?: () => void
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
  // Cached discovery is initial inventory, not a report from the running child.
  let modelsAreDiscovered = args.initialModels !== undefined
  let record =
    readNativeChatSessionOptionCache(args.scopeKey, args.fallbackScopeKey) ??
    createNativeChatSessionOptionRecord(args.agent)
  if (record.agent !== args.agent) {
    record = createNativeChatSessionOptionRecord(args.agent)
  }

  if (args.mode === 'live' && catalog.defaultModelIsCliDefault && !record.defaultContext) {
    record.defaultContext = {
      resolved: false,
      model: cloneDefaultModel(catalog.models.find((model) => model.isDefault) ?? null),
      provisionalOptions: []
    }
  }
  const resolveDefaultContext = (): void => {
    const context = record.defaultContext
    if (!context || context.resolved || !modelsAreDiscovered || models.length === 0) {
      return
    }
    const model = models.find((model) => model.isDefault) ?? null
    if (!record.model && model && context.model) {
      const provisional = record.valuesByModel[context.model.id] ?? {}
      for (const id of context.provisionalOptions) {
        if (provisional[id]) {
          record.valuesByModel[model.id] = {
            ...record.valuesByModel[model.id],
            [id]: provisional[id]
          }
        }
      }
    }
    record.defaultContext = {
      resolved: true,
      model: cloneDefaultModel(model),
      provisionalOptions: []
    }
    if (!record.model) {
      record.currentModel = undefined
    }
  }
  resolveDefaultContext()

  if (args.reportedValues) {
    applyNativeChatReportedSessionOptions(record, args.reportedValues)
  }
  // Drafts validate a future launch; inventory cannot invalidate a running session.
  const untrackRetiredDraftModel = (): boolean => {
    if (
      args.mode !== 'draft' ||
      !catalog.discoveredModelsAreAuthoritative ||
      !modelsAreDiscovered
    ) {
      return false
    }
    const trackedId = typeof record.model?.value === 'string' ? record.model.value : null
    if (!trackedId || models.some((model) => model.id === trackedId)) {
      return false
    }
    clearNativeChatSessionModel(record)
    return true
  }
  if (untrackRetiredDraftModel()) {
    writeNativeChatSessionOptionCache(args.scopeKey, record)
  }
  const activeModels = (): CatalogModel[] => withTrackedNativeChatModel(catalog, models, record)
  const retainCurrentModel = (target?: CatalogModel): void => {
    if (args.mode !== 'live') {
      return
    }
    const id = resolveEffectiveNativeChatModelId(catalog, models, record)
    record.currentModel =
      target?.id === id ? target : record.currentModel?.id === id ? record.currentModel : undefined
    const known =
      models.some((model) => model.id === id) ||
      record.currentModel ||
      record.defaultContext?.model?.id === id ||
      catalog.models.some((model) => model.id === id)
    record.currentModel = cloneDefaultModel(
      known ? (activeModels().find((model) => model.id === id) ?? null) : null
    )
  }
  retainCurrentModel()
  if (args.mode === 'live' || args.reportedValues) {
    writeNativeChatSessionOptionCache(args.scopeKey, record)
  }
  let snapshot = buildNativeChatSessionOptionSnapshot({
    catalog,
    models: activeModels(),
    record,
    mode: args.mode,
    liveTransport: 'catalog'
  })
  const listeners = new Set<(value: SessionOptionDescriptor[]) => void>()

  const publish = (): SessionOptionDescriptor[] => {
    retainCurrentModel()
    writeNativeChatSessionOptionCache(args.scopeKey, record)
    snapshot = buildNativeChatSessionOptionSnapshot({
      catalog,
      models: activeModels(),
      record,
      mode: args.mode,
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

  // Initial discovery may correct the provisional context while an effort is in flight.
  const setTrackedValue = (
    optionId: string,
    value: SessionOptionValue,
    source: 'applied' | 'dispatched',
    target?: CatalogModel
  ): string | null => {
    const modelId = setTrackedSessionOption(
      record,
      optionId,
      value,
      source,
      resolveEffectiveNativeChatModelId(catalog, activeModels(), record)
    )
    if (optionId === 'model') {
      retainCurrentModel(target)
    }
    return modelId
  }

  /** The sole answer to "may this id become the persisted `-m` launch flag?", read at
   *  persist time because a probe can settle mid-pick. Before one, `isDefault` is just
   *  the seed's guess, so only an id the session actually tracks is evidence of
   *  anything; after one, an authoritative list that omits the id proves it retired —
   *  adopting either would emit an `-m` that is fatal on an account without it.
   *  Both branches sit behind one precondition: some real list must carry the id.
   *  A raw launch flag and an agent report both enter the record verbatim, so an id
   *  neither list knows names nothing, whatever put it there. */
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

  /** Every persist path — picker applies and typed commands — funnels through here. */
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
    refreshModels: () => args.refreshModels?.(),
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
      resolveDefaultContext()
      untrackRetiredDraftModel()
      publish()
    },
    contextWindowTokens: (modelId) =>
      activeModels().find((model) => model.id === modelId)?.contextWindowTokens ?? null
  }
}
