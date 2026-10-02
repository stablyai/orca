import {
  findCatalogModel,
  type AgentSessionOptionCatalog,
  type CatalogMidSessionApply,
  type CatalogModel,
  type CatalogOptionApply
} from '../../../../shared/agent-session-option-catalog'
import type {
  SessionOptionDescriptor,
  SessionOptionSetResult,
  SessionOptionValue
} from '../../../../shared/native-chat-session-options'
import { buildNativeChatSessionOptionCommand } from '../../../../shared/native-chat-session-option-commands'
import {
  getTrackedSessionOption as getTrackedOption,
  isFlipOnlyMidSession,
  type NativeChatSessionOptionRecord
} from '../../../../shared/native-chat-session-option-state'
import type {
  NativeChatSessionOptionDispatchCommand,
  NativeChatSessionOptionDispatchResult
} from './native-chat-session-option-command-dispatch'
import {
  flattenNativeChatSessionOptionRecord,
  type NativeChatSessionOptionMode
} from './native-chat-session-option-snapshot'
import {
  createSerializedApplyQueue,
  currentApply,
  restartValues,
  trackedModelId
} from './native-chat-session-option-apply-state'

export type SessionOptionApplyContext = {
  mode: NativeChatSessionOptionMode
  catalog: AgentSessionOptionCatalog
  getModels: () => CatalogModel[]
  getRecord: () => NativeChatSessionOptionRecord
  dispatchCommand: NativeChatSessionOptionDispatchCommand
  restartSession?: (values: Record<string, SessionOptionValue>) => Promise<void> | void
  restartAgentPickerOptions?: boolean
  onAgentPicker?: () => void
  /** The one persist entry point, shared with typed commands: it owns both the
   *  null-model guard and whether the id may be adopted as the launch default. */
  persist: (modelId: string | null, optionId: string, value: SessionOptionValue) => void
  onDraftValuesChanged?: (values: Record<string, SessionOptionValue>) => void
  publish: () => SessionOptionDescriptor[]
  clearModelTruth: () => void
  setTrackedValue: (
    optionId: string,
    value: SessionOptionValue,
    source: 'applied' | 'dispatched'
  ) => string | null
}

function finish(
  ctx: SessionOptionApplyContext,
  args?: {
    modelId: string | null
    optionId: string
    value: SessionOptionValue
    skipPersist?: boolean
  }
): SessionOptionSetResult {
  if (args && !args.skipPersist) {
    ctx.persist(args.modelId, args.optionId, args.value)
  }
  const snapshot = ctx.publish()
  const record = ctx.getRecord()
  const draftModelId = trackedModelId(record)
  if (ctx.mode === 'draft' && draftModelId !== null) {
    ctx.onDraftValuesChanged?.(flattenNativeChatSessionOptionRecord(record, draftModelId))
  }
  return { snapshot }
}

async function handleAgentPicker(
  ctx: SessionOptionApplyContext,
  midSession: Extract<CatalogMidSessionApply, { kind: 'agent-picker' }>
): Promise<SessionOptionSetResult> {
  await (midSession.delivery
    ? ctx.dispatchCommand(midSession.command, { delivery: midSession.delivery })
    : ctx.dispatchCommand(midSession.command))
  ctx.clearModelTruth()
  const snapshot = ctx.publish()
  ctx.onAgentPicker?.()
  return { snapshot }
}

async function dispatchLiveCommand(
  ctx: SessionOptionApplyContext,
  args: {
    optionId: string
    value: SessionOptionValue
    apply: CatalogOptionApply
    modelId: string | null
  }
): Promise<NativeChatSessionOptionDispatchResult | void> {
  const models = ctx.getModels()
  const record = ctx.getRecord()
  const command = buildNativeChatSessionOptionCommand({
    optionId: args.optionId,
    value: args.value,
    apply: args.apply,
    modelId: args.modelId,
    catalog: ctx.catalog,
    models,
    record
  })
  if (!command) {
    throw new Error('This option can only be set when the session starts.')
  }
  const detectAgentInteraction =
    args.apply.midSession?.kind === 'command'
      ? args.apply.midSession.detectAgentInteraction
      : args.apply.composedIntoModel && ctx.catalog.modelApply.midSession?.kind === 'command'
        ? ctx.catalog.modelApply.midSession.detectAgentInteraction
        : undefined
  const expectedChoiceLabel =
    args.optionId === 'model' && typeof args.value === 'string'
      ? (findCatalogModel({ ...ctx.catalog, models }, args.value)?.label ?? args.value)
      : args.apply.composedIntoModel && args.modelId
        ? findCatalogModel({ ...ctx.catalog, models }, args.modelId)?.label
        : undefined
  return detectAgentInteraction
    ? await ctx.dispatchCommand(command, {
        detectAgentInteraction,
        expectedChoiceLabel
      })
    : await ctx.dispatchCommand(command)
}

function applyDispatchOutcome(
  ctx: SessionOptionApplyContext,
  dispatchResult: NativeChatSessionOptionDispatchResult | void
): SessionOptionSetResult | null {
  if (dispatchResult?.outcome === 'rejected') {
    throw new Error('Claude kept the current model.')
  }
  if (dispatchResult?.outcome === 'unknown') {
    throw new Error('Could not verify the model change; open the terminal to check.')
  }
  if (dispatchResult?.outcome === 'interaction-required') {
    const snapshot = ctx.publish()
    ctx.onAgentPicker?.()
    return { snapshot }
  }
  return null
}

async function applySetOption(
  ctx: SessionOptionApplyContext,
  id: string,
  value: SessionOptionValue
): Promise<SessionOptionSetResult> {
  const resolved = currentApply(ctx, id)
  if (!resolved) {
    throw new Error(`Unknown session option: ${id}`)
  }
  const { apply, modelId: previousModelId } = resolved
  if (
    ctx.mode === 'live' &&
    apply.midSession?.kind === 'agent-picker' &&
    !ctx.restartAgentPickerOptions
  ) {
    throw new Error('This option must be changed in the agent picker.')
  }

  if (
    ctx.mode === 'live' &&
    (apply.midSession?.kind === 'restart' ||
      (apply.midSession?.kind === 'agent-picker' && ctx.restartAgentPickerOptions))
  ) {
    if (!ctx.restartSession) {
      throw new Error('This session cannot be restarted from chat.')
    }
    const values = restartValues(ctx, id, value, previousModelId)
    await ctx.restartSession(values)
    const nextModelId = typeof values.model === 'string' ? values.model : previousModelId
    if (nextModelId) {
      const record = ctx.getRecord()
      record.model = { value: nextModelId, source: 'applied' }
      record.valuesByModel[nextModelId] = Object.fromEntries(
        Object.entries(values)
          .filter(([optionId]) => optionId !== 'model')
          .map(([optionId, optionValue]) => [
            optionId,
            { value: optionValue, source: 'applied' as const }
          ])
      )
    }
    return finish(ctx, { modelId: nextModelId, optionId: id, value })
  }

  const liveFlipOnly = ctx.mode === 'live' && isFlipOnlyMidSession(apply.midSession)
  const trackedToggle = liveFlipOnly
    ? getTrackedOption(ctx.getRecord(), previousModelId, id)
    : undefined
  if (liveFlipOnly && !trackedToggle) {
    // Why: a flip from an unknown baseline cannot honor an absolute target.
    throw new Error('Current value is unknown; use the Toggle action instead.')
  }
  // Why: same absolute target must never re-dispatch a flip (would invert the agent).
  if (liveFlipOnly && trackedToggle?.value === value) {
    return { snapshot: ctx.publish() }
  }
  // Why: baseline for detecting a model switch, typed command, or agent report
  // that lands mid-dispatch, so the commit below never overwrites newer state.
  const trackedModelBeforeDispatch = trackedModelId(ctx.getRecord())
  const trackedBeforeDispatch =
    ctx.mode === 'live' && id !== 'model'
      ? getTrackedOption(ctx.getRecord(), previousModelId, id)
      : undefined

  let dispatchResult: NativeChatSessionOptionDispatchResult | void = undefined
  if (ctx.mode === 'live') {
    dispatchResult = await dispatchLiveCommand(ctx, {
      optionId: id,
      value,
      apply,
      modelId: previousModelId
    })
  } else if (!apply.launchArgs && !apply.composedIntoModel) {
    throw new Error('This option is only available after the session starts.')
  }

  const early = applyDispatchOutcome(ctx, dispatchResult)
  if (early) {
    return early
  }
  // A harness-confirmed command is authoritative immediately; commands with
  // no confirmation remain dispatched until telemetry reports the new value.
  const source =
    liveFlipOnly || ctx.mode !== 'live' || dispatchResult?.outcome === 'applied'
      ? 'applied'
      : 'dispatched'

  const record = ctx.getRecord()
  if (id === 'model' && previousModelId !== value) {
    const previousValues = previousModelId ? record.valuesByModel[previousModelId] : undefined
    record.model = undefined
    if (ctx.mode === 'live' && typeof value === 'string') {
      const nextModel = findCatalogModel({ ...ctx.catalog, models: ctx.getModels() }, value)
      // Session-wide controls such as Claude effort and fast mode survive a
      // model switch. A plain model selection authoritatively selects the
      // composed control default too (`opus` means 200k, not `opus[1m]`).
      record.valuesByModel[value] = Object.fromEntries(
        (nextModel?.options ?? []).flatMap((option) => {
          if (option.apply.composedIntoModel) {
            return [[option.id, { value: option.kind.defaultValue, source }]]
          }
          const tracked = previousValues?.[option.id]
          return tracked ? [[option.id, tracked]] : []
        })
      )
    }
  }

  if (liveFlipOnly) {
    // Why: typed flips, reports, or model changes during dispatch supersede the
    // baseline this absolute target was computed from.
    if (trackedModelId(record) !== trackedModelBeforeDispatch) {
      return finish(ctx, { modelId: previousModelId, optionId: id, value, skipPersist: true })
    }
    if (getTrackedOption(record, previousModelId, id) !== trackedToggle) {
      return finish(ctx, { modelId: previousModelId, optionId: id, value, skipPersist: true })
    }
    // Why: never persist unconfirmed flip-only state into durable defaults.
    ctx.setTrackedValue(id, value, source)
    return finish(ctx, { modelId: previousModelId, optionId: id, value, skipPersist: true })
  }

  if (ctx.mode === 'live' && id !== 'model') {
    // Why: a model switch, typed command, or agent report during dispatch supersedes
    // the baseline this commit was computed from — committing now would overwrite
    // newer state and could write/persist a model-scoped value under the new model.
    if (
      trackedModelId(record) !== trackedModelBeforeDispatch ||
      getTrackedOption(record, previousModelId, id) !== trackedBeforeDispatch
    ) {
      return finish(ctx, { modelId: previousModelId, optionId: id, value, skipPersist: true })
    }
  }

  const modelId = ctx.setTrackedValue(id, value, source)
  return finish(ctx, { modelId: modelId ?? previousModelId, optionId: id, value })
}

async function applyInvokeAction(
  ctx: SessionOptionApplyContext,
  id: string
): Promise<SessionOptionSetResult> {
  const resolved = currentApply(ctx, id)
  if (!resolved) {
    throw new Error(`Unknown session option: ${id}`)
  }
  const { apply, modelId } = resolved
  if (apply.midSession?.kind === 'agent-picker') {
    if (ctx.mode !== 'live') {
      throw new Error('This option is only available after the session starts.')
    }
    return handleAgentPicker(ctx, apply.midSession)
  }
  if (!isFlipOnlyMidSession(apply.midSession)) {
    throw new Error('This option requires a value.')
  }
  if (ctx.mode !== 'live') {
    throw new Error('This option is only available after the session starts.')
  }
  if (getTrackedOption(ctx.getRecord(), modelId, id)) {
    throw new Error('This option has a known value; choose On or Off instead.')
  }
  // Why: an unknown baseline remains unknown after one inversion.
  await ctx.dispatchCommand(apply.midSession.command)
  return finish(ctx)
}

export function createSessionOptionAppliers(ctx: SessionOptionApplyContext): {
  setOption: (id: string, value: SessionOptionValue) => Promise<SessionOptionSetResult>
  invokeAction: (id: string) => Promise<SessionOptionSetResult>
} {
  const serialize = createSerializedApplyQueue()
  return {
    setOption: (id, value) => serialize(() => applySetOption(ctx, id, value)),
    invokeAction: (id) => serialize(() => applyInvokeAction(ctx, id))
  }
}
