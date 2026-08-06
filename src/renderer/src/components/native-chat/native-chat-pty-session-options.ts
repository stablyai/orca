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
  withTrackedNativeChatModel,
  type NativeChatSessionOptionMode
} from './native-chat-session-option-snapshot'
import type { NativeChatSessionOptionDispatchCommand } from './native-chat-session-option-command-dispatch'

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
  const activeModels = (): CatalogModel[] => withTrackedNativeChatModel(catalog, models, record)
  let snapshot = buildNativeChatSessionOptionSnapshot({
    catalog,
    models: activeModels(),
    record,
    mode: args.mode
  })
  const listeners = new Set<(value: SessionOptionDescriptor[]) => void>()

  const publish = (): SessionOptionDescriptor[] => {
    writeNativeChatSessionOptionCache(args.scopeKey, record)
    snapshot = buildNativeChatSessionOptionSnapshot({
      catalog,
      models: activeModels(),
      record,
      mode: args.mode
    })
    for (const listener of listeners) {
      listener(snapshot)
    }
    return snapshot
  }

  const clearModelTruth = (): void => {
    clearNativeChatSessionModel(record)
  }

  const setTrackedValue = (
    optionId: string,
    value: SessionOptionValue,
    source: 'applied' | 'dispatched'
  ): string | null => setTrackedSessionOption(record, optionId, value, source)

  const persist = (modelId: string | null, optionId: string, value: SessionOptionValue): void => {
    if (modelId) {
      void args.persistSelection?.({ modelId, optionId, value })
    }
  }

  const appliers = createSessionOptionAppliers({
    mode: args.mode,
    catalog,
    getModels: activeModels,
    getRecord: () => record,
    dispatchCommand: args.dispatchCommand,
    onAgentPicker: args.onAgentPicker,
    persistSelection: args.persistSelection,
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
      publish()
    }
  }
}
