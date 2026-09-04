export const PI_THINKING_LEVELS = [
  { id: 'off', label: 'Off' },
  { id: 'minimal', label: 'Minimal' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra High' },
  { id: 'max', label: 'Max' }
] as const

export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number]

export type PiModelTableRow = {
  provider: string
  model: string
  thinking: boolean
}

// Why: model discovery output can include paste-sized noisy lines; only the first fields matter.
export function getPiModelTableFields(line: string, maxFields: number): string[] {
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
