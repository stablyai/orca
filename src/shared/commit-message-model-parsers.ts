import { assertJsonTextStructureWithinLimits } from './json-text-structure-limit'
import { parseClaudeModelList } from './claude-model-list-probe'
import { labelFromModelId } from './model-id-label'
import type { CommitMessageModel, ThinkingLevel } from './commit-message-agent-spec'
import { PI_THINKING_LEVELS, parsePiModelTableRow } from './pi-model-list-probe'

export const COMMIT_MESSAGE_MODEL_JSON_STRUCTURE_LIMITS = {
  structuralTokens: 64 * 1024,
  nestingDepth: 16
} as const

export const BASIC_THINKING_LEVELS: ThinkingLevel[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' }
]

export const OPENAI_THINKING_LEVELS: ThinkingLevel[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra High' }
]

export const CLAUDE_THINKING_LEVELS: ThinkingLevel[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra High' },
  { id: 'max', label: 'Max' }
]

function uniqueModels(models: CommitMessageModel[]): CommitMessageModel[] {
  const seen = new Set<string>()
  return models.filter((model) => {
    if (!model.id || seen.has(model.id)) {
      return false
    }
    seen.add(model.id)
    return true
  })
}

function* iterateModelOutputLines(output: string): Generator<string> {
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

export function withOpenAiThinking(
  id: string
): Pick<CommitMessageModel, 'thinkingLevels' | 'defaultThinkingLevel'> {
  return /(?:gpt-5|codex)/i.test(id)
    ? { thinkingLevels: OPENAI_THINKING_LEVELS, defaultThinkingLevel: 'low' }
    : {}
}

export function parseClaudeModels(stdout: string): CommitMessageModel[] {
  return uniqueModels(
    parseClaudeModelList(stdout).map((model) => {
      const thinkingLevels = CLAUDE_THINKING_LEVELS.filter((level) =>
        model.effortLevels.includes(level.id)
      )
      return {
        id: model.id,
        label: model.label,
        ...(model.description ? { description: model.description } : {}),
        ...(thinkingLevels.length > 0
          ? {
              thinkingLevels,
              defaultThinkingLevel: thinkingLevels.some((level) => level.id === 'low')
                ? 'low'
                : thinkingLevels[0].id
            }
          : {}),
        ...(model.supportsFastMode ? { supportsFastMode: true } : {})
      }
    })
  )
}

export function parseCodexModels(stdout: string): CommitMessageModel[] {
  try {
    assertJsonTextStructureWithinLimits(stdout, COMMIT_MESSAGE_MODEL_JSON_STRUCTURE_LIMITS)
    const parsed = JSON.parse(stdout) as {
      models?: {
        slug?: string
        display_name?: string
        supported_reasoning_levels?: { effort?: string }[]
        default_reasoning_level?: string
      }[]
    }
    return uniqueModels(
      (parsed.models ?? [])
        .filter((model) => model.slug && model.display_name)
        .map((model) => ({
          id: model.slug!,
          label: model.display_name!,
          ...(model.supported_reasoning_levels?.length
            ? {
                thinkingLevels: model.supported_reasoning_levels
                  .map((level) => level.effort)
                  .filter((effort): effort is string => Boolean(effort))
                  .map((effort) => ({
                    id: effort,
                    label: effort === 'xhigh' ? 'Extra High' : labelFromModelId(effort)
                  })),
                defaultThinkingLevel: model.default_reasoning_level ?? 'low'
              }
            : {})
        }))
    )
  } catch {
    return []
  }
}

export function parseLineModels(stdout: string): CommitMessageModel[] {
  const models: CommitMessageModel[] = []
  for (const rawLine of iterateModelOutputLines(stdout)) {
    const id = rawLine.trim()
    if (id.length === 0 || id.includes(' ')) {
      continue
    }
    models.push({
      id,
      label: labelFromModelId(id),
      ...withOpenAiThinking(id)
    })
  }
  return uniqueModels(models)
}

export function parsePiModels(stdout: string): CommitMessageModel[] {
  const models: CommitMessageModel[] = []
  for (const rawLine of iterateModelOutputLines(stdout)) {
    const row = parsePiModelTableRow(rawLine)
    if (!row) {
      continue
    }

    const id = `${row.provider}/${row.model}`
    models.push({
      id,
      label: `${labelFromModelId(row.provider)} ${labelFromModelId(row.model)}`,
      ...(row.thinking
        ? {
            thinkingLevels: PI_THINKING_LEVELS.map((level) => ({
              id: level.id,
              label: level.label
            })),
            defaultThinkingLevel: 'low'
          }
        : {})
    })
  }
  return uniqueModels(models)
}

export function parseCursorModels(stdout: string): CommitMessageModel[] {
  const models: CommitMessageModel[] = []
  for (const rawLine of iterateModelOutputLines(stdout)) {
    const match = /^([^\s]+)\s+-\s+(.+)$/.exec(rawLine.trim())
    if (!match) {
      continue
    }
    models.push({
      id: match[1],
      label: match[2].replace(/\s+\((?:default|current)\)$/i, ''),
      ...withOpenAiThinking(match[1])
    })
  }
  return uniqueModels(models)
}

export function parseAntigravityModels(stdout: string): CommitMessageModel[] {
  const models: CommitMessageModel[] = []
  for (const rawLine of iterateModelOutputLines(stdout)) {
    const id = rawLine.trim()
    if (id.length === 0) {
      continue
    }
    models.push({
      id,
      label: id
    })
  }
  return uniqueModels(models)
}
