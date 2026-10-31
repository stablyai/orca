import {
  findCatalogModel,
  findCatalogOption,
  type AgentSessionOptionCatalog,
  type CatalogMidSessionApply,
  type CatalogModel,
  type CatalogOptionApply
} from './agent-session-option-catalog'
import type {
  SessionOptionDescriptor,
  SessionOptionSetResult,
  SessionOptionValue
} from './native-chat/input/native-chat-session-options'
import { buildNativeChatSessionOptionCommand } from './native-chat/input/native-chat-session-option-commands'
import {
  flattenNativeChatSessionOptionRecord,
  getTrackedSessionOption as getTrackedOption,
  isFlipOnlyMidSession,
  type NativeChatSessionOptionRecord
} from './native-chat/input/native-chat-session-option-state'
import type {
  NativeChatSessionOptionDispatchCommand,
  NativeChatSessionOptionDispatchResult
} from './native-chat-session-option-dispatch'
import { SessionOptionApplyError } from './native-chat-session-option-apply-failure'
import {
  resolveEffectiveNativeChatModelId,
  type NativeChatSessionOptionMode
} from './native-chat/input/native-chat-session-option-snapshot'

type SessionOptionApplyContext = {
  mode: NativeChatSessionOptionMode
  catalog: AgentSessionOptionCatalog
  getModels: () => CatalogModel[]
  getRecord: () => NativeChatSessionOptionRecord
  dispatchCommand: NativeChatSessionOptionDispatchCommand
  onAgentPicker?: () => void
  /** Share persistence with typed commands so null-model and launch-adoption checks apply everywhere. */
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

/** Serialize absolute targets so they observe prior flips instead of stale baselines. */
function createSerializedApplyQueue(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn)
    tail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}

function currentApply(
  ctx: SessionOptionApplyContext,
  optionId: string
): { apply: CatalogOptionApply; modelId: string | null } | null {
  const models = ctx.getModels()
  // Resolve the effective model shown in the picker, even without tracked selection.
  const modelId = resolveEffectiveNativeChatModelId(ctx.catalog, models, ctx.getRecord())
  if (optionId === 'model') {
    return { apply: ctx.catalog.modelApply, modelId }
  }
  const model = modelId ? findCatalogModel({ ...ctx.catalog, models }, modelId) : undefined
  const option = findCatalogOption(model, optionId)
  return option ? { apply: option.apply, modelId } : null
}

/** Guard record changes only; discovery moving a default row must not discard accepted values. */
function trackedModelId(record: NativeChatSessionOptionRecord): string | null {
  return typeof record.model?.value === 'string' ? record.model.value : null
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
    throw new SessionOptionApplyError('startOnly')
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
    throw new SessionOptionApplyError('modelRejected')
  }
  if (dispatchResult?.outcome === 'unknown') {
    ctx.clearModelTruth()
    ctx.publish()
    throw new SessionOptionApplyError('modelUnverified')
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
    throw new SessionOptionApplyError('unknownOption', id)
  }
  const { apply, modelId: previousModelId } = resolved
  if (ctx.mode === 'live' && apply.midSession?.kind === 'agent-picker') {
    throw new SessionOptionApplyError('agentPickerOnly')
  }

  const liveFlipOnly = ctx.mode === 'live' && isFlipOnlyMidSession(apply.midSession)
  const trackedToggle = liveFlipOnly
    ? getTrackedOption(ctx.getRecord(), previousModelId, id)
    : undefined
  if (liveFlipOnly && !trackedToggle) {
    // An unknown baseline cannot honor an absolute flip target.
    throw new SessionOptionApplyError('toggleBaselineUnknown')
  }
  // Retrying an already reached flip target would invert it.
  if (liveFlipOnly && trackedToggle?.value === value) {
    return { snapshot: ctx.publish() }
  }
  // Flip-only state cannot heal through reports; preserve it as best-known applied state.
  const source = liveFlipOnly || ctx.mode !== 'live' ? 'applied' : 'dispatched'

  // Capture record identity so dispatch cannot overwrite newer model or option state.
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
    throw new SessionOptionApplyError('afterStartOnly')
  }

  const early = applyDispatchOutcome(ctx, dispatchResult)
  if (early) {
    return early
  }

  const record = ctx.getRecord()
  if (id === 'model' && previousModelId !== value) {
    record.model = undefined
    if (ctx.mode === 'live' && typeof value === 'string') {
      // Model switches can reset destination effort and toggles.
      delete record.valuesByModel[value]
    }
  }

  if (liveFlipOnly) {
    // Mid-dispatch reports, typed flips or model changes supersede this target’s baseline.
    if (trackedModelId(record) !== trackedModelBeforeDispatch) {
      return finish(ctx, { modelId: previousModelId, optionId: id, value, skipPersist: true })
    }
    if (getTrackedOption(record, previousModelId, id) !== trackedToggle) {
      return finish(ctx, { modelId: previousModelId, optionId: id, value, skipPersist: true })
    }
    // Keep unconfirmed flip-only state out of durable defaults.
    ctx.setTrackedValue(id, value, source)
    return finish(ctx, { modelId: previousModelId, optionId: id, value, skipPersist: true })
  }

  if (ctx.mode === 'live' && id !== 'model') {
    // Newer model/option records supersede this dispatch; never persist its value under the new model.
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
    throw new SessionOptionApplyError('unknownOption', id)
  }
  const { apply, modelId } = resolved
  if (apply.midSession?.kind === 'agent-picker') {
    if (ctx.mode !== 'live') {
      throw new SessionOptionApplyError('afterStartOnly')
    }
    return handleAgentPicker(ctx, apply.midSession)
  }
  if (!isFlipOnlyMidSession(apply.midSession)) {
    throw new SessionOptionApplyError('valueRequired')
  }
  if (ctx.mode !== 'live') {
    throw new SessionOptionApplyError('afterStartOnly')
  }
  if (getTrackedOption(ctx.getRecord(), modelId, id)) {
    throw new SessionOptionApplyError('toggleValueKnown')
  }
  // Inverting an unknown baseline still leaves an unknown absolute value.
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
