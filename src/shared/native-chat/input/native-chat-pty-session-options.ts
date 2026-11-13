import { getAgentSessionOptionCatalog } from '../../agent-session/options/agent-session-option-catalog'
import type { CatalogModel } from '../../agent-session/options/agent-session-option-catalog-types'
import type { AgentType } from '../../agent-status/contracts/agent-status-types'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface,
  SessionOptionValue,
  NativeChatPersistSelection
} from './native-chat-session-options'
import { recordNativeChatSessionOptionCommand } from './native-chat-session-option-commands'
import {
  applyNativeChatReportedSessionOptions,
  clearNativeChatSessionModel,
  createNativeChatSessionOptionRecord,
  setTrackedSessionOption
} from './native-chat-session-option-state'
import {
  readNativeChatSessionOptionSeed,
  type NativeChatSessionOptionLease,
  type NativeChatSessionOptionOwner,
  readNativeChatSessionOptionCache,
  writeNativeChatSessionOptionCache
} from './native-chat-session-option-cache'
import {
  acquireNativeChatSessionOptionOwnerLease,
  settleNativeChatSessionOptionLease
} from './native-chat-session-option-owner'
import { createSessionOptionAppliers } from './native-chat-session-option-apply'
import {
  buildNativeChatSessionOptionSnapshot,
  resolveEffectiveNativeChatModelId,
  withTrackedNativeChatModel,
  type NativeChatSessionOptionMode
} from './native-chat-session-option-snapshot'
import type { NativeChatSessionOptionDispatchCommand } from './native-chat-session-option-dispatch'

export type NativeChatPtySessionOptionsSurface = SessionOptionsSurface & {
  recordOutgoingCommand(command: string): void
  reportSessionOptions(values: Record<string, SessionOptionValue>): void
  replaceModels(models: CatalogModel[]): void
  reconcileOwner(): void
  /** The context window the host's model listing states for `modelId`, or null. */
  contextWindowTokens(modelId: string): number | null
}

export type CreateNativeChatPtySessionOptionsArgs = {
  agent: AgentType
  owner?: NativeChatSessionOptionOwner
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
  persistSelection?: NativeChatPersistSelection
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
  let record = args.owner
    ? readNativeChatSessionOptionSeed(args.scopeKey, args.owner, args.fallbackScopeKey)
    : (readNativeChatSessionOptionCache(args.scopeKey, args.fallbackScopeKey) ??
      createNativeChatSessionOptionRecord(args.agent))
  if (record.agent !== args.agent) {
    record = createNativeChatSessionOptionRecord(args.agent)
  }

  if (
    !args.owner &&
    args.reportedValues &&
    applyNativeChatReportedSessionOptions(record, args.reportedValues)
  ) {
    writeNativeChatSessionOptionCache(args.scopeKey, record)
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
    if (!args.owner) {
      writeNativeChatSessionOptionCache(args.scopeKey, record)
    }
    const nextSnapshot = buildNativeChatSessionOptionSnapshot({
      catalog,
      models: activeModels(),
      legacyInventory: models,
      record,
      mode: args.mode,
      modelLabel: args.modelLabel,
      liveTransport: 'catalog'
    })
    if (JSON.stringify(nextSnapshot) !== JSON.stringify(snapshot)) {
      snapshot = nextSnapshot
      if (!args.owner || mountedLease?.isCurrent()) {
        for (const listener of listeners) {
          listener(snapshot)
        }
      }
    }
    return snapshot
  }

  let unsubscribeOwner: (() => void) | null = null
  let mountedLease: NativeChatSessionOptionLease | null = null
  let operationLease: NativeChatSessionOptionLease | null = null
  let hasSubscribed = false
  const acquire = (): NativeChatSessionOptionLease | null =>
    acquireNativeChatSessionOptionOwnerLease(args.scopeKey, args.owner, args.fallbackScopeKey)
  const reconcileOwner = (): void => {
    if (mountedLease || listeners.size === 0) {
      return
    }
    mountedLease = acquire()
    if (!mountedLease) {
      return
    }
    record = mountedLease.record
    unsubscribeOwner = mountedLease.subscribe(publish)
    if (args.reportedValues) {
      mountedLease.transact(() =>
        applyNativeChatReportedSessionOptions(record, args.reportedValues!)
      )
    }
    publish()
  }
  const canCommit = (): boolean =>
    !args.owner || (operationLease ?? mountedLease)?.isCurrent() === true
  const settle = <T>(mutate: () => T): T | undefined =>
    args.owner ? settleNativeChatSessionOptionLease(operationLease, mutate) : mutate()
  const transact = (mutate: () => boolean): void => {
    if (!args.owner) {
      if (mutate()) {
        publish()
      }
      return
    }
    if (hasSubscribed && listeners.size === 0) {
      return
    }
    const held = acquire()
    if (!held) {
      return
    }
    record = held.record
    try {
      held.transact(mutate)
      publish()
    } finally {
      held.release()
    }
  }
  const runOperation = async <T>(run: () => Promise<T>): Promise<T> => {
    if (!args.owner) {
      return run()
    }
    if (hasSubscribed && listeners.size === 0) {
      throw new Error('The chat is no longer open.')
    }
    const held = acquire()
    if (!held) {
      throw new Error('The chat changed before the command was sent.')
    }
    operationLease = held
    record = held.record
    try {
      return await run()
    } finally {
      operationLease = null
      held.release()
    }
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
  const modelIsAdoptableAsLaunchDefault = (modelId: string, acceptedPick: boolean): boolean => {
    const listedIn = (list: readonly CatalogModel[]): boolean =>
      list.some((model) => model.id === modelId)
    if (!listedIn(models) && !listedIn(catalog.models)) {
      return false
    }
    return modelsAreDiscovered
      ? !catalog.discoveredModelsAreAuthoritative || listedIn(models)
      : acceptedPick || record.model !== undefined
  }

  const persist = (modelId: string | null, optionId: string, value: SessionOptionValue): void => {
    if (modelId) {
      void args.persistSelection?.({
        modelId,
        optionId,
        value,
        adoptModelAsLaunchDefault: modelIsAdoptableAsLaunchDefault(modelId, optionId === 'model')
      })
    }
  }

  const appliers = createSessionOptionAppliers({
    mode: args.mode,
    runOperation,
    canCommit,
    settle,
    catalog,
    getModels: activeModels,
    getRecord: () => record,
    dispatchCommand: (command, options) => {
      if (!canCommit()) {
        throw new Error('The chat changed before the command was sent.')
      }
      return args.dispatchCommand(command, options)
    },
    onAgentPicker: args.onAgentPicker,
    persist,
    onDraftValuesChanged: args.onDraftValuesChanged,
    publish,
    clearModelTruth: () => clearNativeChatSessionModel(record),
    setTrackedValue
  })

  return {
    getSnapshot: () => snapshot,
    setOption: appliers.setOption,
    invokeAction: appliers.invokeAction,
    reconcileOwner,
    subscribe: (listener) => {
      hasSubscribed = true
      listeners.add(listener)
      reconcileOwner()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          unsubscribeOwner?.()
          unsubscribeOwner = null
          mountedLease?.release()
          mountedLease = null
        }
      }
    },
    recordOutgoingCommand: (command) => {
      transact(() => {
        const result = recordNativeChatSessionOptionCommand({
          catalog,
          models: activeModels(),
          record,
          command,
          persist
        })
        if (result.opensAgentPicker) {
          args.onAgentPicker?.()
        }
        return result.changed
      })
    },
    reportSessionOptions: (values) => {
      transact(() => applyNativeChatReportedSessionOptions(record, values))
    },
    replaceModels: (nextModels) => {
      if (args.owner && hasSubscribed && listeners.size === 0) {
        return
      }
      const held = acquire()
      if (args.owner && !held) {
        return
      }
      if (held) {
        record = held.record
      }
      try {
        models = [...nextModels]
        modelsAreDiscovered = true
        publish()
      } finally {
        held?.release()
      }
    },
    contextWindowTokens: (modelId) =>
      models.find((model) => model.id === modelId)?.contextWindowTokens ?? null
  }
}
