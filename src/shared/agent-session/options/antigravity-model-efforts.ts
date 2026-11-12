import type { AgentSessionModelOption } from '../agent-session-wire'
import type { CatalogModel } from './agent-session-option-catalog-types'
import { ANTIGRAVITY_LAUNCH_OPTION_CATALOG } from './agent-session-option-catalog-antigravity'
import type {
  AgentChoicePatch,
  AgentModelOptionChoices
} from '../../agent-launch/choices/agent-launch-choices'

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max'
}
type ListedModel = { id: string; label: string }
export type AntigravityModelFamily = AgentSessionModelOption & {
  variants: Readonly<Record<string, string>>
}

function effortVariant(id: string) {
  const level = LEVELS.find((level) => id.endsWith(`-${level}`) && id.length > level.length + 1)
  return level && !/\s/.test(id) ? { base: id.slice(0, -level.length - 1), level } : undefined
}

/** Only distinct CLI-listed siblings establish a model's selectable efforts. */
export function groupAntigravityModelEfforts(
  models: readonly ListedModel[]
): AntigravityModelFamily[] {
  const listed = new Map(models.map((model) => [model.id, model]))
  const families = new Map<string, Map<string, ListedModel>>()
  for (const model of models) {
    const variant = effortVariant(model.id)
    if (variant) {
      const siblings = families.get(variant.base) ?? new Map()
      siblings.set(variant.level, model)
      families.set(variant.base, siblings)
    }
  }
  const emitted = new Set<string>()
  return models.flatMap((model) => {
    const variant = effortVariant(model.id)
    const ownFamily = families.get(model.id)
    const base = ownFamily && ownFamily.size >= 2 ? model.id : (variant?.base ?? model.id)
    const siblings = families.get(base)
    if (!siblings || siblings.size < 2) {
      if (emitted.has(model.id)) {
        return []
      }
      emitted.add(model.id)
      return [{ ...model, isDefault: false, efforts: [], variants: {} }]
    }
    if (emitted.has(base)) {
      return []
    }
    emitted.add(base)
    const bare = listed.get(base)
    const first = siblings.entries().next().value
    const label =
      bare?.label ??
      (first &&
        first[1].label.replace(new RegExp(`\\s+(?:\\(${first[0]}\\)|${first[0]})$`, 'i'), ''))
    return [
      {
        id: base,
        label: label && label !== first?.[1].label ? label : (bare?.label ?? base),
        isDefault: false,
        efforts: LEVELS.filter((level) => siblings.has(level)).map((level) => ({
          value: level,
          label: LABELS[level]
        })),
        variants: Object.fromEntries([...siblings].map(([level, row]) => [level, row.id]))
      }
    ]
  })
}

export function antigravityEffortRefusal(
  models: readonly ListedModel[],
  model: string,
  effort: string
): string | undefined {
  // Display-name inventories predate the CLI's slug contract and cannot validate a pair.
  if (!models.length || models.some(({ id }) => /\s/.test(id))) {
    return undefined
  }
  const families = groupAntigravityModelEfforts(models)
  const family =
    families.find((row) => row.id === model) ??
    families.find((row) => Object.values(row.variants).includes(model))
  const variant = family?.id === model && family.efforts.length ? undefined : effortVariant(model)
  if (
    family?.efforts.some(({ value }) => value === effort) &&
    (!variant || variant.level === effort)
  ) {
    return undefined
  }
  if (models.some(({ id }) => id === model) && variant?.level === effort) {
    return undefined
  }
  if (
    LEVELS.some((level) => level === effort) &&
    models.some(({ id }) => id === `${model}-${effort}`)
  ) {
    return undefined
  }
  const alternatives =
    family?.efforts.map(({ value }) => `--model ${family.id} --effort ${value}`) ?? []
  const exact = models.find(({ id }) => id === model)
  if (exact) {
    alternatives.push(`--model ${exact.id} (without --effort)`)
  } else if (!alternatives.length) {
    alternatives.push(
      ...models
        .filter(({ id }) => effortVariant(id)?.base === model)
        .map(({ id }) => `--model ${id} (without --effort)`)
    )
  }
  const reason =
    variant && exact
      ? `Antigravity model ${model} already names ${LABELS[variant.level]}.`
      : `Antigravity model ${model} does not list effort ${effort}.`
  return `${reason} ${alternatives.length ? `Use ${alternatives.join(' or ')}.` : 'Choose a model and effort from agy models, or omit --effort.'}`
}

export function antigravityModelSelection(
  models: readonly (AgentSessionModelOption & { variants?: Readonly<Record<string, string>> })[],
  model?: string
) {
  const exact = models.find((row) => row.id === model)
  if (exact) {
    return { row: exact, effort: undefined }
  }
  for (const row of models) {
    const effort = row.efforts.find(({ value }) => row.variants?.[value] === model)?.value
    if (effort) {
      return { row, effort }
    }
  }
  return undefined
}

export function antigravityTerminalChoicePatch(
  models: readonly (AgentSessionModelOption & { variants?: Readonly<Record<string, string>> })[],
  current: AgentModelOptionChoices,
  patch: AgentChoicePatch
): AgentChoicePatch {
  if (patch.model !== undefined) {
    const row = antigravityModelSelection(models, patch.model ?? undefined)?.row
    const saved = patch.options?.effort ?? current.options?.effort
    return row?.efforts.some(({ value }) => value === saved)
      ? patch
      : { ...patch, options: { ...patch.options, effort: null } }
  }
  if (patch.options?.effort !== undefined) {
    const selected = antigravityModelSelection(models, current.model)
    return {
      ...patch,
      ...(selected?.effort ? { model: selected.row.id } : {}),
      options: { ...patch.options, effort: patch.options.effort || null }
    }
  }
  return patch
}

/** Live terminal tracking keeps literal ids while borrowing only their family's listed controls. */
export function antigravityTerminalCatalogModels(
  models: readonly (AgentSessionModelOption & { variants?: Readonly<Record<string, string>> })[]
): CatalogModel[] {
  return models.flatMap((row) => {
    const options = row.efforts.length
      ? (ANTIGRAVITY_LAUNCH_OPTION_CATALOG.unknownModelOptions ?? []).map((option) => ({
          ...option,
          kind: { type: 'select' as const, choices: row.efforts, defaultValue: '' }
        }))
      : []
    return [
      { id: row.id, label: row.label, options },
      ...Object.values(row.variants ?? {}).map((id) => ({ id, label: row.label, options }))
    ]
  })
}
