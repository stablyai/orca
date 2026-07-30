import {
  findCatalogModel,
  findCatalogOption,
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
import type { NativeChatSessionOptionRecord } from './native-chat-session-option-cache'
import { buildNativeChatSessionOptionCommand } from './native-chat-session-option-command-builder'
import type {
  NativeChatSessionOptionDispatchCommand,
  NativeChatSessionOptionDispatchResult
} from './native-chat-session-option-command-dispatch'
import { getTrackedOption, isFlipOnlyMidSession } from './native-chat-session-option-flip'
import {
  flattenNativeChatSessionOptionRecord,
  type NativeChatSessionOptionMode
} from './native-chat-session-option-snapshot'

type SessionOptionApplyContext = {
  mode: NativeChatSessionOptionMode
  catalog: AgentSessionOptionCatalog
  getModels: () => CatalogModel[]
  getRecord: () => NativeChatSessionOptionRecord
  dispatchCommand: NativeChatSessionOptionDispatchCommand
  onAgentPicker?: () => void
  persistSelection?: (args: {
    modelId: string
    optionId: string
    value: SessionOptionValue
  }) => Promise<void> | void
  onDraftValuesChanged?: (values: Record<string, SessionOptionValue>) => void
  publish: () => SessionOptionDescriptor[]
  clearModelTruth: () => void
  setTrackedValue: (
    optionId: string,
    value: SessionOptionValue,
    source: 'applied' | 'dispatched'
  ) => string | null
}

/** Why: ordered applies make a later absolute target observe the result of an
 * earlier flip instead of dispatching against a stale baseline. */
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
  const record = ctx.getRecord()
  const modelId = typeof record.model?.value === 'string' ? record.model.value : null
  if (optionId === 'model') {
    return { apply: ctx.catalog.modelApply, modelId }
  }
  const model = modelId
    ? findCatalogModel({ ...ctx.catalog, models: ctx.getModels() }, modelId)
    : undefined
  const option = findCatalogOption(model, optionId)
  return option ? { apply: option.apply, modelId } : null
}

function persist(
  ctx: SessionOptionApplyContext,
  modelId: string | null,
  optionId: string,
  value: SessionOptionValue
): void {
  if (modelId) {
    void ctx.persistSelection?.({ modelId, optionId, value })
  }
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
    persist(ctx, args.modelId, args.optionId, args.value)
  }
  const snapshot = ctx.publish()
  const record = ctx.getRecord()
  if (ctx.mode === 'draft' && typeof record.model?.value === 'string') {
    ctx.onDraftValuesChanged?.(flattenNativeChatSessionOptionRecord(record, record.model.value))
  }
  return { snapshot }
}

async function handleAgentPicker(
  ctx: SessionOptionApplyContext,
  midSession: Extract<CatalogMidSessionApply, { kind: 'agent-picker' }>
): Promise<SessionOptionSetResult> {
  await ctx.dispatchCommand(midSession.command)
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
    ctx.clearModelTruth()
    ctx.publish()
    throw new Error('Could not verify the model change; open the terminal to check.')
  }
  if (dispatchResult?.outcome === 'interaction-required') {
    ctx.clearModelTruth()
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
  if (ctx.mode === 'live' && apply.midSession?.kind === 'agent-picker') {
    throw new Error('This option must be changed in the agent picker.')
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
  // Why: flip-only never heals via agent report — track as applied best-known.
  const source = liveFlipOnly || ctx.mode !== 'live' ? 'applied' : 'dispatched'

  // Why: baseline for detecting a model switch, typed command, or agent report
  // that lands mid-dispatch, so the commit below never overwrites newer state.
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

  const record = ctx.getRecord()
  if (id === 'model' && previousModelId !== value) {
    record.model = undefined
    if (ctx.mode === 'live' && typeof value === 'string') {
      // Why: switching models can reset effort/toggles for the destination model.
      delete record.valuesByModel[value]
    }
  }

  if (liveFlipOnly) {
    // Why: typed flips, reports, or model changes during dispatch supersede the
    // baseline this absolute target was computed from.
    const modelStill = typeof record.model?.value === 'string' ? record.model.value : null
    if (modelStill !== previousModelId) {
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
    const modelStill = typeof record.model?.value === 'string' ? record.model.value : null
    if (
      modelStill !== previousModelId ||
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
