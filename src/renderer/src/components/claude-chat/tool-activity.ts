// Maps a tool_use to a short human activity label, like the official
// Claude Code GUI ("Editing foo.ts…", "Running command…").

function basenameOf(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

function fileOf(input: unknown): string | null {
  if (input !== null && typeof input === 'object' && 'file_path' in input) {
    const fp = (input as { file_path: unknown }).file_path
    if (typeof fp === 'string') {
      return basenameOf(fp)
    }
  }
  return null
}

// Short inline summary shown next to the bold tool name in the timeline,
// mirroring the official GUI ("Read portfolio-design-preferences.md",
// "Bash List project files…").
export function describeToolSummary(toolName: string, input: unknown): string {
  const obj = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const file = fileOf(input)
  if (file) {
    return file
  }
  if (toolName === 'Bash') {
    const desc = obj.description
    if (typeof desc === 'string' && desc) {
      return desc
    }
    const cmd = obj.command
    return typeof cmd === 'string' ? cmd.slice(0, 80) : ''
  }
  if (toolName === 'Grep' || toolName === 'Glob') {
    const pattern = obj.pattern
    return typeof pattern === 'string' ? pattern : ''
  }
  if (toolName === 'Task' || toolName === 'Agent') {
    const desc = obj.description
    return typeof desc === 'string' ? desc : ''
  }
  if (toolName === 'WebSearch' || toolName === 'WebFetch') {
    const q = obj.query ?? obj.url
    return typeof q === 'string' ? q : ''
  }
  const first = Object.values(obj).find((v) => typeof v === 'string')
  return typeof first === 'string' ? first.slice(0, 80) : ''
}

export function describeToolActivity(toolName: string, input: unknown): string {
  const file = fileOf(input)
  switch (toolName) {
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return file ? `Editing ${file}…` : 'Editing…'
    case 'Write':
      return file ? `Writing ${file}…` : 'Writing a file…'
    case 'Read':
      return file ? `Reading ${file}…` : 'Reading…'
    case 'Bash':
      return 'Running command…'
    case 'Grep':
    case 'Glob':
      return 'Searching…'
    case 'WebSearch':
    case 'WebFetch':
      return 'Searching the web…'
    case 'Task':
    case 'Agent':
      return 'Running agent…'
    case 'TodoWrite':
      return 'Updating plan…'
    default:
      return `Using ${toolName}…`
  }
}
