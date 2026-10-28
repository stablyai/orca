const MAX_CONTEXT_CHARS = 36_000

export function trimAgentSessionContext(value: string, source = 'terminal output'): string {
  if (value.length <= MAX_CONTEXT_CHARS) {
    return value
  }
  const omitted = value.length - MAX_CONTEXT_CHARS
  const marker = `\n\n[Earlier ${source} omitted: ${omitted} characters]\n\n`
  return `${marker}${value.slice(-(MAX_CONTEXT_CHARS - marker.length))}`
}
