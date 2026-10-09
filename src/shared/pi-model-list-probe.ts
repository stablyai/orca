import type { CommitMessageModel } from './commit-message-agent-spec'
import { labelFromModelId } from './model-id-label'

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
  const parts = getPiModelTableFields(line, 6)
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
  for (const rawLine of iteratePiModelOutputLines(stdout)) {
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

function* iteratePiModelOutputLines(output: string): Generator<string> {
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

// Why: model discovery output can include paste-sized noisy lines; only the first fields matter.
function getPiModelTableFields(line: string, maxFields: number): string[] {
  const fields: string[] = []
  let tokenStart = -1

  for (let index = 0; index <= line.length; index += 1) {
    const isEnd = index === line.length
    if (!isEnd && !isPiModelTableWhitespace(line.charCodeAt(index))) {
      if (tokenStart === -1) {
        tokenStart = index
      }
      continue
    }
    if (tokenStart !== -1) {
      fields.push(line.slice(tokenStart, index))
      tokenStart = -1
      if (fields.length >= maxFields) {
        break
      }
    }
  }

  return fields
}

function isPiModelTableWhitespace(code: number): boolean {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 160 ||
    code === 5760 ||
    (code >= 8192 && code <= 8202) ||
    code === 8232 ||
    code === 8233 ||
    code === 8239 ||
    code === 8287 ||
    code === 12288 ||
    code === 65279
  )
}
