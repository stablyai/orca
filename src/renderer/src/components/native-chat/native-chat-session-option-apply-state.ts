import {
  findCatalogModel,
  findCatalogOption,
  type CatalogOptionApply
} from '../../../../shared/agent-session-option-catalog'
import type { SessionOptionValue } from '../../../../shared/native-chat-session-options'
import type { NativeChatSessionOptionRecord } from '../../../../shared/native-chat-session-option-state'
import type { SessionOptionApplyContext } from './native-chat-session-option-apply'
import { resolveEffectiveNativeChatModelId } from './native-chat-session-option-snapshot'

export function currentApply(
  ctx: SessionOptionApplyContext,
  optionId: string
): { apply: CatalogOptionApply; modelId: string | null } | null {
  const models = ctx.getModels()
  const modelId = resolveEffectiveNativeChatModelId(ctx.catalog, models, ctx.getRecord())
  if (optionId === 'model') {
    return { apply: ctx.catalog.modelApply, modelId }
  }
  const model = modelId ? findCatalogModel({ ...ctx.catalog, models }, modelId) : undefined
  const option = findCatalogOption(model, optionId)
  return option ? { apply: option.apply, modelId } : null
}

export function restartValues(
  ctx: SessionOptionApplyContext,
  optionId: string,
  value: SessionOptionValue,
  previousModelId: string | null
): Record<string, SessionOptionValue> {
  const modelId = optionId === 'model' && typeof value === 'string' ? value : previousModelId
  if (!modelId) {
    return { [optionId]: value }
  }
  const record = ctx.getRecord()
  const model = findCatalogModel({ ...ctx.catalog, models: ctx.getModels() }, modelId)
  const values: Record<string, SessionOptionValue> = { model: modelId }
  for (const option of model?.options ?? []) {
    const tracked = record.valuesByModel[modelId]?.[option.id]?.value
    values[option.id] = tracked ?? option.kind.defaultValue
  }
  values[optionId] = value
  return values
}

export function createSerializedApplyQueue(): <T>(fn: () => Promise<T>) => Promise<T> {
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

export function trackedModelId(record: NativeChatSessionOptionRecord): string | null {
  return typeof record.model?.value === 'string' ? record.model.value : null
}
