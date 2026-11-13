import type { AgentSessionModelOption } from '../agent-session-wire'
import type { CatalogModel } from './agent-session-option-catalog-types'
import { ANTIGRAVITY_LAUNCH_OPTION_CATALOG } from './agent-session-option-catalog-antigravity'
import type {
  AgentChoicePatch,
  AgentModelOptionChoices
} from '../../agent-launch/choices/agent-launch-choices'

const LEVELS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']
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

function labelledEffort(label: string) {
  const match = /\s+\((low|medium|high|xhigh|extra high|max)\)$/i.exec(label)
  return match
    ? {
        level: match[1].toLowerCase().replace('extra high', 'xhigh'),
        label: label.slice(0, match.index)
      }
    : undefined
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
  for (const [base, siblings] of families) {
    const bare = listed.get(base)
    const labelled = bare && labelledEffort(bare.label)
    if (bare && labelled && !siblings.has(labelled.level)) {
      siblings.set(labelled.level, bare)
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
      (bare && (labelledEffort(bare.label)?.label ?? bare.label)) ??
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

export function normalizeAntigravityModel(
  model: string | undefined,
  effort: string | undefined,
  models: readonly ListedModel[] = []
): { model?: string; warning?: string } {
  if (!model) {
    return effort
      ? {
          warning:
            'Antigravity: no model selected; starting its default without the requested effort.'
        }
      : {}
  }
  if (!effort) {
    return { model }
  }
  const requested = LEVELS.indexOf(effort)
  if (requested === -1) {
    return {
      model,
      warning: "Antigravity: couldn't match the effort; starting the selected model."
    }
  }
  const own = models.filter((row) => effortVariant(row.id)?.base === model)
  const base = own.length ? model : (effortVariant(model)?.base ?? model)
  const siblings = new Map<string, string>()
  for (const row of models) {
    const variant = effortVariant(row.id)
    if (variant?.base === base) {
      siblings.set(variant.level, row.id)
    } else if (row.id === base) {
      const level = labelledEffort(row.label)?.level
      if (level && !siblings.has(level)) {
        siblings.set(level, row.id)
      }
    }
  }
  const nearest = [...siblings].sort(([a], [b]) => {
    const ai = LEVELS.indexOf(a)
    const bi = LEVELS.indexOf(b)
    return Math.abs(ai - requested) - Math.abs(bi - requested) || ai - bi
  })[0]
  if (nearest) {
    return { model: nearest[1] }
  }
  const variant = effortVariant(model)
  if (variant?.level === effort) {
    return { model }
  }
  if (variant) {
    return {
      model: `${variant.base}-${effort}`,
      warning: 'Antigravity: model list unavailable; trying the requested effort.'
    }
  }
  return { model, warning: "Antigravity: couldn't match the effort; starting the selected model." }
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
      ? { ...patch, model: row.variants?.[String(saved)] ?? patch.model }
      : { ...patch, options: { ...patch.options, effort: null } }
  }
  if (patch.options?.effort !== undefined) {
    const selected = antigravityModelSelection(models, current.model)
    return {
      ...patch,
      ...(selected && patch.options.effort === null
        ? { model: selected.row.id }
        : selected?.row.variants?.[String(patch.options.effort)]
          ? { model: selected.row.variants[String(patch.options.effort)] }
          : {}),
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
    return [...new Set([row.id, ...Object.values(row.variants ?? {})])].map((id) => ({
      id,
      label: row.label,
      options
    }))
  })
}
