import type { CommitMessageModel } from './commit-message-agent-spec'
import { labelFromModelId } from './model-id-label'
import { getProcessOutputFields, iterateProcessOutputLines } from './process-output-field-scanner'

/** `pi --list-models` prints the table these parsers read. */
export const PI_MODEL_LIST_ARGS = ['--list-models']

/** Every level `pi --thinking` accepts, low to high minus `off` ordering only in the help. */
export const PI_THINKING_LEVELS = [
  { id: 'off', label: 'Off' },
  { id: 'minimal', label: 'Minimal' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra High' },
  { id: 'max', label: 'Max' }
] as const

export type PiModelTableRow = {
  provider: string
  model: string
  thinking: boolean
}

export function parsePiModelTableRow(line: string): PiModelTableRow | null {
  const parts = getProcessOutputFields(line, 6)
  if (parts.length < 6 || parts[0] === 'provider') {
    return null
  }
  const thinking = parts[4]
  if (thinking !== 'yes' && thinking !== 'no') {
    return null
  }
  return { provider: parts[0], model: parts[1], thinking: thinking === 'yes' }
}

/** Parses `pi --list-models`: whitespace columns, `provider`/`model`/`thinking` first. */
export function parsePiModelList(stdout: string): CommitMessageModel[] {
  const models: CommitMessageModel[] = []
  const seen = new Set<string>()
  for (const rawLine of iterateProcessOutputLines(stdout)) {
    const row = parsePiModelTableRow(rawLine)
    if (!row) {
      continue
    }
    const id = `${row.provider}/${row.model}`
    if (seen.has(id)) {
      continue
    }
    seen.add(id)
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
  return models
}
