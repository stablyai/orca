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
import { describeClaudePermissionModeCycle } from './claude-permission-mode-cycle'
import {
  buildNativeChatSessionOptionSnapshot,
  resolveEffectiveNativeChatModelId,
  withTrackedNativeChatModel,
  type NativeChatSessionOptionMode
} from './native-chat-session-option-snapshot'
import type {
  NativeChatModeCycleDispatch,
  NativeChatSessionOptionDispatchCommand
} from './native-chat-session-option-command-dispatch'

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
}

export type CreateNativeChatPtySessionOptionsArgs = {
  agent: AgentType
  scopeKey: string
  fallbackScopeKey?: string
  initialModels?: readonly CatalogModel[]
  mode: NativeChatSessionOptionMode
  reportedValues?: Record<string, SessionOptionValue> | null
  /** The live session's actual launch args/env (not the settings default for
   *  new sessions) — gates Claude's bypassPermissions choice. */
  agentArgs?: string | null
  agentEnv?: Record<string, string> | null
  dispatchCommand: NativeChatSessionOptionDispatchCommand
  dispatchModeCycle?: NativeChatModeCycleDispatch
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
  // The enrichment cache only ever holds probe output, so being handed a list at all
  // means `isDefault` below names the account's real default rather than the seed guess.
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
  /** Why: an authoritative probe proved this id gone; left tracked it would re-enter
   *  the picker via re-injection and re-persist the fatal `-m` on any later option
   *  write, undoing the settings retirement. */
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
    agentArgs: args.agentArgs,
    agentEnv: args.agentEnv
  })
  const listeners = new Set<(value: SessionOptionDescriptor[]) => void>()

  const publish = (): SessionOptionDescriptor[] => {
    writeNativeChatSessionOptionCache(args.scopeKey, record)
    snapshot = buildNativeChatSessionOptionSnapshot({
      catalog,
      models: activeModels(),
      record,
      mode: args.mode,
      agentArgs: args.agentArgs,
      agentEnv: args.agentEnv
    })
    for (const listener of listeners) {
      listener(snapshot)
    }
    return snapshot
  }

  const clearModelTruth = (): void => {
    clearNativeChatSessionModel(record)
  }

  /** Resolved at commit, not pre-dispatch: with nothing tracked the pre-dispatch id was
   *  only the seed's guess at grok's default, and a probe landing mid-dispatch replaces
   *  it with the id the CLI actually reported — the model the command truly reached. */
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

  /** The sole answer to "may this id become the persisted `-m` launch flag?", read at
   *  persist time because a probe can settle mid-pick. Before one, `isDefault` is just
   *  the seed's guess, so only an id the session actually tracks is evidence of
   *  anything; after one, an authoritative list that omits the id proves it retired —
   *  adopting either would emit an `-m` that is fatal on an account without it. */
  const modelIsAdoptableAsLaunchDefault = (modelId: string): boolean =>
    modelsAreDiscovered
      ? !catalog.discoveredModelsAreAuthoritative || models.some((model) => model.id === modelId)
      : record.model !== undefined

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
    applyModeCycle: async (optionId, value) => {
      const option = catalog.sessionOptions?.find((candidate) => candidate.id === optionId)
      const midSession = option?.apply.midSession
      if (midSession?.kind !== 'cycle-key' || typeof value !== 'string') {
        return { outcome: 'unknown', detail: 'This option cannot be changed from chat.' }
      }
      if (!args.dispatchModeCycle) {
        return { outcome: 'unknown', detail: 'No live terminal is attached to this chat.' }
      }
      const result = await args.dispatchModeCycle({ key: midSession.key, target: value })
      return {
        outcome: result.outcome,
        detail: describeClaudePermissionModeCycle(value, result)
      }
    },
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
    }
  }
}
