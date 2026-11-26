import { stripAnsiEscapeSequences } from '../../../terminal/protocol/escape/ansi-escape-sequences'

export const ANTIGRAVITY_EFFORT_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
] as const

export type AntigravityEffortLevel = (typeof ANTIGRAVITY_EFFORT_LEVELS)[number]

export type AntigravityListedModel = {
  modelId: string
  name: string
}

const LEVEL_SUFFIX = new RegExp(`^(.+)-(${ANTIGRAVITY_EFFORT_LEVELS.join('|')})$`, 'i')

/** Split `<family>-<level>` case-insensitively, normalizing `level` to lowercase. */
export function splitAntigravityLeveledModelId(
  modelId: string
): { family: string; level: AntigravityEffortLevel } | null {
  const match = LEVEL_SUFFIX.exec(modelId)
  const rawLevel = match?.[2].toLowerCase()
  const level = ANTIGRAVITY_EFFORT_LEVELS.find((candidate) => candidate === rawLevel)
  return match && level ? { family: match[1], level } : null
}

function* iterateOutputLines(output: string): Generator<string> {
  let lineStart = 0
  for (let index = 0; index < output.length; index++) {
    const code = output.charCodeAt(index)
    if (code !== 10 && code !== 13) {
      continue
    }
    yield output.slice(lineStart, index)
    if (code === 13 && output.charCodeAt(index + 1) === 10) {
      index++
    }
    lineStart = index + 1
  }
  if (lineStart <= output.length) {
    yield output.slice(lineStart)
  }
}

/** Parse `<id>\t<label>` (or space-padded table) rows from `agy models`, skipping headers and duplicates. */
export function parseAntigravityModelRows(stdout: string): AntigravityListedModel[] {
  const rows: AntigravityListedModel[] = []
  const seen = new Set<string>()
  for (const rawLine of iterateOutputLines(stdout)) {
    const line = stripAnsiEscapeSequences(rawLine).trim()
    if (!line) {
      continue
    }
    const tabIndex = line.indexOf('\t')
    const spacesMatch = tabIndex === -1 ? /\s{2,}/.exec(line) : null
    if (tabIndex === -1 && !spacesMatch) {
      continue
    }
    const modelId = (
      tabIndex !== -1 ? line.slice(0, tabIndex) : line.slice(0, spacesMatch!.index)
    ).trim()
    const name = (
      tabIndex !== -1
        ? line.slice(tabIndex + 1)
        : line.slice(spacesMatch!.index + spacesMatch![0].length)
    ).trim()
    if (
      !modelId ||
      !name ||
      /\s/.test(modelId) ||
      /^(?:id|model)$/i.test(modelId) ||
      seen.has(modelId)
    ) {
      continue
    }
    seen.add(modelId)
    rows.push({ modelId, name })
  }
  return rows
}

/** Extract effort choices for a collapsed `<family>` from `<family>-<level>` rows. */
export function antigravityFamilyEfforts(
  family: string,
  models: readonly AntigravityListedModel[]
): { efforts: { value: AntigravityEffortLevel; label: string }[] } | undefined {
  const prefix = `${family.toLowerCase()}-`
  const efforts = ANTIGRAVITY_EFFORT_LEVELS.flatMap((value) => {
    const variant = models.find((model) => model.modelId.toLowerCase() === `${prefix}${value}`)
    return variant ? [{ value, label: /\(([^()]+)\)$/.exec(variant.name)?.[1] ?? value }] : []
  })
  return efforts.length > 0 ? { efforts } : undefined
}

/** The model choices a chat offers: a family for levels listed as `<family>-<level>` (two or
 *  more, and the family isn't a model itself), every other model on its own. */
export function antigravityModelChoices(
  models: readonly AntigravityListedModel[]
): { id: string; label: string }[] {
  const ids = new Set(models.map((model) => model.modelId))
  const levels = new Map<string, number>()
  for (const model of models) {
    const family = splitAntigravityLeveledModelId(model.modelId)?.family
    if (family && !ids.has(family)) {
      levels.set(family, (levels.get(family) ?? 0) + 1)
    }
  }
  const choices = new Map<string, string>()
  for (const model of models) {
    const family = splitAntigravityLeveledModelId(model.modelId)?.family
    if (family && (levels.get(family) ?? 0) > 1) {
      if (!choices.has(family)) {
        choices.set(family, model.name.replace(/\s*\([^()]+\)$/, ''))
      }
    } else {
      choices.set(model.modelId, model.name)
    }
  }
  return [...choices].map(([id, label]) => ({ id, label }))
}
