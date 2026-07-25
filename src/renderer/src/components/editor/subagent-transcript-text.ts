// Why: subagent JSONL payloads are untyped — tool args and results arrive as
// strings, block arrays, or arbitrary objects, and every surface needs them flat.

export function safeJsonStringify(val: unknown, fallback = ''): string {
  if (val === undefined || val === null) {
    return fallback
  }
  if (typeof val === 'string') {
    return val
  }
  try {
    return JSON.stringify(val, null, 2)
  } catch {
    return fallback
  }
}

export function extractToolResultContent(content: unknown): string {
  if (content === undefined || content === null) {
    return ''
  }
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    const textParts: string[] = []
    for (const block of content) {
      if (typeof block === 'string') {
        textParts.push(block)
      } else if (block && typeof block === 'object') {
        const item = block as Record<string, unknown>
        if (typeof item.text === 'string') {
          textParts.push(item.text)
        } else if (typeof item.content === 'string') {
          textParts.push(
            typeof item.content === 'string' ? item.content : safeJsonStringify(item.content)
          )
        } else if (typeof item.thinking === 'string') {
          textParts.push(item.thinking)
        }
      }
    }
    if (textParts.length > 0) {
      return textParts.join('\n')
    }
  }
  if (content && typeof content === 'object') {
    const item = content as Record<string, unknown>
    if (typeof item.text === 'string') {
      return item.text
    }
  }
  return safeJsonStringify(content)
}
