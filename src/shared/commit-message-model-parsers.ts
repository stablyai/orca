import { assertJsonTextStructureWithinLimits } from './json-text-structure-limit'
import { parseClaudeModelList } from './claude-model-list-probe'
import { labelFromModelId } from './model-id-label'
import { iterateProcessOutputLines } from './process-output-field-scanner'
import type { CommitMessageModel, ThinkingLevel } from './commit-message-agent-spec'

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
  for (const rawLine of iterateProcessOutputLines(stdout)) {
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

export function parseCursorModels(stdout: string): CommitMessageModel[] {
  const models: CommitMessageModel[] = []
  for (const rawLine of iterateProcessOutputLines(stdout)) {
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
  for (const rawLine of iterateProcessOutputLines(stdout)) {
    const line = rawLine.trim()
    const separator = line.indexOf('\t')
    const id = (separator === -1 ? line : line.slice(0, separator)).trim()
    const label = separator === -1 ? id : line.slice(separator + 1).trim()
    // Older agy versions list display names; current versions emit id<TAB>label.
    if (
      !id ||
      !label ||
      (separator === -1 && !/^.+ \((?:low|medium|high|thinking)\)$/i.test(id)) ||
      (separator !== -1 && (/\s/.test(id) || /^(?:id|model)$/i.test(id)))
    ) {
      continue
    }
    models.push({
      id,
      label
    })
  }
  return uniqueModels(models)
}
