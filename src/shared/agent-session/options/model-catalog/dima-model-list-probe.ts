import type { CommitMessageModel } from '../../../source-control/ai/generation/commit-message-agent-spec'
import { labelFromModelId } from './model-id-label'

/** One selectable model as dima's App Server lists it. */
export type DimaListedModel = {
  providerId: string
  providerName?: string
  modelId: string
  modelName?: string
}

// oxlint-disable-next-line no-control-regex -- a control character would break the launch line
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/
// A provider id ends at the first `/`.
const PROVIDER_ID = /^[^\s/]+$/

/** dim's own `PROVIDER/MODEL` reference: the provider ends at the first `/`, so model ids keep theirs. */
export function dimaModelSelector(providerId: string, modelId: string): string | null {
  return PROVIDER_ID.test(providerId) &&
    modelId !== '' &&
    !CONTROL_CHARACTER.test(providerId + modelId)
    ? `${providerId}/${modelId}`
    : null
}

export function parseDimaModelSelector(
  value: string
): { providerId: string; modelId: string } | null {
  const slash = value.indexOf('/')
  const providerId = value.slice(0, slash)
  const modelId = value.slice(slash + 1)
  return slash > 0 && dimaModelSelector(providerId, modelId) ? { providerId, modelId } : null
}

/** `--provider` scopes `--model`; a bare id runs on dima's effective provider. */
export function dimaModelLaunchArgs(value: string): string[] {
  const selector = parseDimaModelSelector(value)
  return selector
    ? ['--provider', selector.providerId, '--model', selector.modelId]
    : ['--model', value]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Selectable rows of one `provider.models.query` page and its cursor; disabled and unavailable rows stay out. */
export function dimaQueryPageModels(page: unknown): { models: DimaListedModel[]; next: unknown } {
  const reply = isRecord(page) ? page : null
  const rows = Array.isArray(reply?.models) ? reply.models : []
  const models = rows.flatMap((value: unknown): DimaListedModel[] => {
    const row = isRecord(value) ? value : null
    const model = isRecord(row?.model) ? row.model : null
    const providerId = text(row?.providerId)
    const modelId = text(model?.id)
    // selectableOnly already omits them; dim's own picker checks again.
    if (!providerId || !modelId || row?.disabled === true || model?.unavailableReason != null) {
      return []
    }
    return [
      { providerId, providerName: text(row?.providerName), modelId, modelName: text(model?.name) }
    ]
  })
  return { models, next: reply?.next ?? null }
}

/** Selectable models of one provider's `provider.catalog` reply, for daemons without provider.models.query. */
export function dimaCatalogReplyModels(
  provider: { providerId: string; providerName?: string },
  reply: unknown
): DimaListedModel[] {
  const catalog = isRecord(reply) && isRecord(reply.catalog) ? reply.catalog : null
  const disabled = new Set(
    Array.isArray(catalog?.disabledModelIds)
      ? catalog.disabledModelIds.filter((id): id is string => typeof id === 'string')
      : []
  )
  const rows = Array.isArray(catalog?.models) ? catalog.models : []
  return rows.flatMap((value: unknown): DimaListedModel[] => {
    const model = isRecord(value) ? value : null
    const modelId = text(model?.id)
    return !modelId || disabled.has(modelId) || model?.unavailableReason != null
      ? []
      : [{ ...provider, modelId, modelName: text(model?.name) }]
  })
}

/** Picker rows keyed by provider; the provider's name tells one model id apart across providers. */
export function dimaCatalogModels(rows: readonly DimaListedModel[]): CommitMessageModel[] {
  const byId = new Map<string, CommitMessageModel>()
  for (const row of rows) {
    const id = dimaModelSelector(row.providerId, row.modelId)
    if (!id || byId.has(id)) {
      continue
    }
    const name = row.modelName?.trim() || labelFromModelId(row.modelId)
    const provider = row.providerName?.trim() || row.providerId
    byId.set(id, {
      id,
      label: `${name} · ${provider}`,
      description: row.providerId
    })
  }
  const models = [...byId.values()]
  const labelCounts = new Map<string, number>()
  for (const model of models) {
    labelCounts.set(model.label, (labelCounts.get(model.label) ?? 0) + 1)
  }
  return models.map((model) =>
    labelCounts.get(model.label) === 1 ? model : { ...model, label: `${model.label} (${model.id})` }
  )
}

/** One `provider.models.query` page (JSON) as picker rows. */
export function parseDimaModelList(stdout: string): CommitMessageModel[] {
  try {
    return dimaCatalogModels(dimaQueryPageModels(JSON.parse(stdout)).models)
  } catch {
    return []
  }
}
