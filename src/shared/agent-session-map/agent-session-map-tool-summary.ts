// One-line summaries of tool inputs for map nodes. The journal keeps full inputs;
// the map shows one line per call. Unknown tools fall back to the first string
// value of the input, then to nothing — never a crash.

const MAX_SUMMARY_LENGTH = 120

function firstString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') {
    return value.trim()
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = firstString(entry)
      if (found !== null) {
        return found
      }
    }
  }
  return null
}

function truncate(text: string): string {
  if (text.length <= MAX_SUMMARY_LENGTH) {
    return text
  }
  return `${text.slice(0, MAX_SUMMARY_LENGTH - 1)}…`
}

/** The input's first line, collapsed: a Bash command or a path reads best on one line. */
function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? ''
  return truncate(line.replace(/\s+/g, ' ').trim())
}

export function agentSessionMapToolSummary(name: string, input: unknown): string {
  if (input === null || input === undefined) {
    return ''
  }
  if (typeof input === 'string') {
    return firstLine(input)
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    const text = firstString(input)
    return text === null ? '' : firstLine(text)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: tool inputs are opaque JSON; only the named fields are read below.
  const record = input as Record<string, unknown>
  switch (name) {
    case 'Bash':
    case 'bash':
      return firstLine(String(record.command ?? record.cmd ?? ''))
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return String(record.file_path ?? record.path ?? record.notebook_path ?? '')
    case 'Grep':
    case 'Glob':
      return firstLine(String(record.pattern ?? ''))
    case 'Agent':
    case 'Task':
      return firstLine(String(record.description ?? record.prompt ?? ''))
    case 'WebFetch':
      return String(record.url ?? '')
    case 'WebSearch':
      return firstLine(String(record.query ?? ''))
    case 'TodoWrite':
      return ''
    default: {
      const text = firstString(record)
      return text === null ? '' : firstLine(text)
    }
  }
}
