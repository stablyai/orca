import { parseAgentHookJson } from './request-body'

export function extractAssistantTextFromLine(line: string): string | undefined {
  let entry: unknown
  try {
    entry = parseAgentHookJson(line)
  } catch {
    return undefined
  }
  if (typeof entry !== 'object' || entry === null) {
    return undefined
  }
  const record = entry as Record<string, unknown>
  if (record.type === 'assistant.message') {
    const data = record.data
    if (typeof data === 'object' && data !== null) {
      const text = extractAssistantContentText((data as Record<string, unknown>).content)
      if (text) {
        return text
      }
    }
  }
  if (
    record.source === 'MODEL' &&
    record.type === 'PLANNER_RESPONSE' &&
    typeof record.content === 'string' &&
    record.content.trim().length > 0
  ) {
    return record.content
  }
  const nestedMessage = record.message as Record<string, unknown> | undefined
  const role =
    record.role ?? nestedMessage?.role ?? (record.type === 'assistant' ? 'assistant' : undefined)
  if (role !== 'assistant') {
    return undefined
  }
  const content = (nestedMessage ?? record).content
  return extractAssistantContentText(content)
}

export function extractAssistantContentText(content: unknown): string | undefined {
  if (typeof content === 'string' && content.trim().length > 0) {
    return content
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'object' && part !== null) {
        const text = (part as Record<string, unknown>).text
        if (typeof text === 'string' && text.trim().length > 0) {
          return text
        }
      }
    }
  }
  return undefined
}
