import {
  findCatalogModel,
  findCatalogOption,
  getAgentSessionOptionCatalog,
  type CatalogMidSessionApply,
  type CatalogModel,
  type CatalogOptionApply
} from '../../../../shared/agent-session-option-catalog'
import type { AgentType } from '../../../../shared/agent-status-types'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface,
  SessionOptionValue
} from '../../../../shared/native-chat-session-options'
import {
  createNativeChatSessionOptionRecord,
  readNativeChatSessionOptionCache,
  writeNativeChatSessionOptionCache
} from './native-chat-session-option-cache'
import {
  buildNativeChatSessionOptionSnapshot,
  flattenNativeChatSessionOptionRecord,
  type NativeChatSessionOptionMode
} from './native-chat-session-option-snapshot'
import { buildNativeChatSessionOptionCommand } from './native-chat-session-option-command-builder'
import type {
  NativeChatSessionOptionDispatchCommand,
  NativeChatSessionOptionDispatchResult
} from './native-chat-session-option-command-dispatch'
import { applyNativeChatReportedSessionOptions } from './native-chat-session-option-reporting'
import { recordNativeChatSessionOptionCommand } from './native-chat-session-option-command-recording'

type PersistSelection = (args: {
  modelId: string
  optionId: string
  value: SessionOptionValue
}) => Promise<void> | void

export type NativeChatPtySessionOptionsSurface = SessionOptionsSurface & {
  recordOutgoingCommand(command: string): void
  reportSessionOptions(values: Record<string, SessionOptionValue>): void
  replaceModels(models: CatalogModel[]): void
}

export type CreateNativeChatPtySessionOptionsArgs = {
  agent: AgentType
  scopeKey: string
  fallbackScopeKey?: string
  initialModels?: readonly CatalogModel[]
  mode: NativeChatSessionOptionMode
  reportedValues?: Record<string, SessionOptionValue> | null
  dispatchCommand: NativeChatSessionOptionDispatchCommand
  onAgentPicker?: () => void
  persistSelection?: PersistSelection
  onDraftValuesChanged?: (values: Record<string, SessionOptionValue>) => void
}

export function createNativeChatPtySessionOptions(
  args: CreateNativeChatPtySessionOptionsArgs
): NativeChatPtySessionOptionsSurface | null {
  const catalog = getAgentSessionOptionCatalog(args.agent)
  if (!catalog) {
    return null
  }
  let models = [...(args.initialModels ?? catalog.models)]
  let record =
    readNativeChatSessionOptionCache(args.scopeKey, args.fallbackScopeKey) ??
    createNativeChatSessionOptionRecord(args.agent)
  if (record.agent !== args.agent) {
    record = createNativeChatSessionOptionRecord(args.agent)
  }

  if (args.reportedValues && applyNativeChatReportedSessionOptions(record, args.reportedValues)) {
    writeNativeChatSessionOptionCache(args.scopeKey, record)
  }
  let snapshot = buildNativeChatSessionOptionSnapshot({
    catalog,
    models,
    record,
    mode: args.mode
  })
  const listeners = new Set<(value: SessionOptionDescriptor[]) => void>()

  const publish = (): SessionOptionDescriptor[] => {
    writeNativeChatSessionOptionCache(args.scopeKey, record)
    snapshot = buildNativeChatSessionOptionSnapshot({
      catalog,
      models,
      record,
      mode: args.mode
    })
    for (const listener of listeners) {
      listener(snapshot)
    }
    return snapshot
  }

  const clearModelTruth = (): void => {
    const modelId = typeof record.model?.value === 'string' ? record.model.value : null
    record.model = undefined
    if (modelId) {
      delete record.valuesByModel[modelId]
    }
  }

  const setTrackedValue = (
    optionId: string,
    value: SessionOptionValue,
    source: 'applied' | 'dispatched'
  ): string | null => {
    if (optionId === 'model') {
      record.model = { value, source }
      return typeof value === 'string' ? value : null
    }
    const modelId = typeof record.model?.value === 'string' ? record.model.value : null
    if (!modelId) {
      return null
    }
    record.valuesByModel[modelId] = {
      ...record.valuesByModel[modelId],
      [optionId]: { value, source }
    }
    return modelId
  }

  const persist = (modelId: string | null, optionId: string, value: SessionOptionValue): void => {
    if (modelId) {
      void args.persistSelection?.({ modelId, optionId, value })
    }
  }

  const currentApply = (
    optionId: string
  ): { apply: CatalogOptionApply; modelId: string | null } | null => {
    const modelId = typeof record.model?.value === 'string' ? record.model.value : null
    if (optionId === 'model') {
      return { apply: catalog.modelApply, modelId }
    }
    const model = modelId ? findCatalogModel({ ...catalog, models }, modelId) : undefined
    const option = findCatalogOption(model, optionId)
    return option ? { apply: option.apply, modelId } : null
  }

  const handleAgentPicker = async (midSession: CatalogMidSessionApply): Promise<void> => {
    if (midSession.kind !== 'agent-picker') {
      return
    }
    await args.dispatchCommand(midSession.command)
    clearModelTruth()
    publish()
    args.onAgentPicker?.()
  }

  const setOption = async (id: string, value: SessionOptionValue) => {
    const resolved = currentApply(id)
    if (!resolved) {
      throw new Error(`Unknown session option: ${id}`)
    }
    const { apply, modelId: previousModelId } = resolved
    if (args.mode === 'live' && apply.midSession?.kind === 'agent-picker') {
      await handleAgentPicker(apply.midSession)
      return { snapshot }
    }
    const source = args.mode === 'live' ? 'dispatched' : 'applied'
    let dispatchResult: NativeChatSessionOptionDispatchResult | void = undefined
    const toggleWasKnown =
      apply.midSession?.kind === 'toggle-command' && previousModelId
        ? record.valuesByModel[previousModelId]?.[id] !== undefined
        : false
    if (args.mode === 'live') {
      const command = buildNativeChatSessionOptionCommand({
        optionId: id,
        value,
        apply,
        modelId: previousModelId,
        catalog,
        models,
        record
      })
      if (!command) {
        throw new Error('This option can only be set when the session starts.')
      }
      const detectAgentInteraction =
        apply.midSession?.kind === 'command'
          ? apply.midSession.detectAgentInteraction
          : apply.composedIntoModel && catalog.modelApply.midSession?.kind === 'command'
            ? catalog.modelApply.midSession.detectAgentInteraction
            : undefined
      const expectedChoiceLabel =
        id === 'model' && typeof value === 'string'
          ? (findCatalogModel({ ...catalog, models }, value)?.label ?? value)
          : undefined
      dispatchResult = detectAgentInteraction
        ? await args.dispatchCommand(command, {
            detectAgentInteraction,
            expectedChoiceLabel
          })
        : await args.dispatchCommand(command)
    } else if (!apply.launchArgs && !apply.composedIntoModel) {
      throw new Error('This option is only available after the session starts.')
    }

    if (dispatchResult?.outcome === 'rejected') {
      throw new Error('Claude kept the current model.')
    }
    if (dispatchResult?.outcome === 'unknown') {
      clearModelTruth()
      publish()
      throw new Error('Could not verify the model change; open the terminal to check.')
    }
    if (dispatchResult?.outcome === 'interaction-required') {
      clearModelTruth()
      publish()
      args.onAgentPicker?.()
      return { snapshot }
    }

    if (apply.midSession?.kind === 'toggle-command' && !toggleWasKnown) {
      return { snapshot: publish() }
    }
    if (id === 'model' && previousModelId !== value) {
      record.model = undefined
      if (args.mode === 'live' && typeof value === 'string') {
        // Why: switching models can reset its effort/toggles. A value cached
        // from an earlier visit to that model is no longer live evidence.
        delete record.valuesByModel[value]
      }
    }
    const modelId = setTrackedValue(id, value, source)
    if (apply.midSession?.kind === 'toggle-command' && previousModelId && source === 'dispatched') {
      record.valuesByModel[previousModelId] = {
        ...record.valuesByModel[previousModelId],
        [id]: { value, source }
      }
    }
    persist(modelId ?? previousModelId, id, value)
    const next = publish()
    if (args.mode === 'draft' && typeof record.model?.value === 'string') {
      args.onDraftValuesChanged?.(flattenNativeChatSessionOptionRecord(record, record.model.value))
    }
    return { snapshot: next }
  }

  return {
    getSnapshot: () => snapshot,
    setOption,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    recordOutgoingCommand: (command) => {
      const result = recordNativeChatSessionOptionCommand({
        catalog,
        models,
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
      publish()
    }
  }
}
