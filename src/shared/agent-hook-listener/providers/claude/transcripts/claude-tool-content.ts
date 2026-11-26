type ClaudeToolUseContent = Record<string, unknown> &
  ({ type: 'tool_use' } | { id: string; name: string; input: unknown })
type ClaudeToolResultContent = Record<string, unknown> &
  ({ type: 'tool_result' } | { tool_use_id: string })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export function isClaudeToolUseContent(value: unknown): value is ClaudeToolUseContent {
  return (
    isRecord(value) &&
    (value.type === 'tool_use' || (hasText(value.id) && hasText(value.name) && 'input' in value))
  )
}

export function isClaudeToolResultContent(value: unknown): value is ClaudeToolResultContent {
  return isRecord(value) && (value.type === 'tool_result' || hasText(value.tool_use_id))
}

export function claudeToolResultFailed(value: Record<string, unknown>): boolean {
  const content = value.content
  return (
    value.is_error === true ||
    (isRecord(content) && typeof content.type === 'string' && content.type.endsWith('_error'))
  )
}

export function* claudeToolResultTextParts(content: unknown): Generator<string> {
  const parts = Array.isArray(content) ? content : [content]
  for (const part of parts) {
    if (typeof part === 'string') {
      yield part
    } else if (part !== undefined && part !== null) {
      const text = isRecord(part) ? (part.text ?? part.content) : undefined
      yield typeof text === 'string' ? text : JSON.stringify(part)
    }
  }
}

export function claudeToolResultText(content: unknown): string {
  return [...claudeToolResultTextParts(content)].join('\n')
}
