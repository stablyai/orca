export type AntigravitySwarmToolCallSummary = {
  name: string
  label: string
}

export type AntigravitySwarmTranscriptStepSummary = {
  type: string
  status: string
  error: string
}

export type AntigravitySwarmTranscriptSummary = {
  steps: number
  activity: string
  activityKind: 'tool' | 'thinking' | ''
  last: AntigravitySwarmTranscriptStepSummary | null
  idle: boolean
  replied: boolean
  mtime: number
}

export type AntigravitySwarmMemberTranscriptEntry = {
  stepIndex: number
  kind: 'user' | 'assistant' | 'error'
  text: string
  thinking?: string
  timestamp?: string
  toolCalls: AntigravitySwarmToolCallSummary[]
}

const BOARD_ACTIVITY: Record<string, string> = {
  swarm_post_message: 'Posting to board',
  swarm_read_board: 'Reading board',
  swarm_wait: 'Wait on board'
}

const MAX_TOOL_LABEL_CHARS = 96

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function oneLine(value: string, maxLength = MAX_TOOL_LABEL_CHARS): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1).trimEnd()}…`
    : normalized
}

function unquote(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function pathBasename(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts.at(-1) || filePath
}

export function describeAntigravityToolCall(toolCall: unknown): string {
  if (!isRecord(toolCall)) {
    return ''
  }
  const name = typeof toolCall.name === 'string' ? toolCall.name : ''
  if (!name) {
    return ''
  }
  if (BOARD_ACTIVITY[name]) {
    return BOARD_ACTIVITY[name]
  }
  const args = isRecord(toolCall.args) ? toolCall.args : {}
  const summary = unquote(args.toolSummary) || unquote(args.toolAction)
  if (summary) {
    return oneLine(summary)
  }
  const path = unquote(args.Path) || unquote(args.AbsolutePath) || unquote(args.TargetFile)
  if (path) {
    const verb =
      name === 'read_file' || name === 'view_file'
        ? 'Read'
        : name === 'write_file' || name === 'write_to_file'
          ? 'Write'
          : name === 'edit_file' || name === 'replace_file_content'
            ? 'Edit'
            : ''
    if (verb) {
      return `${verb} ${pathBasename(path)}`
    }
  }
  if ((name === 'code_search' || name === 'grep_search') && args.Query) {
    return oneLine(`Search ${unquote(args.Query)}`)
  }
  if (name === 'swarm' && args.action) {
    return oneLine(`swarm ${unquote(args.action)} ${unquote(args.name)}`.trim())
  }
  return name
}

function thinkingHeading(thinking: unknown): string {
  if (typeof thinking !== 'string') {
    return ''
  }
  const matches = [...thinking.matchAll(/(?:^|\n)\s*\*\*([^*\n]{3,96})\*\*\s*(?=\n|$)/g)]
  const last = matches.at(-1)
  return last?.[1] ? oneLine(last[1]) : ''
}

function parseStepLine(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function isTurnEnded(lines: readonly string[]): boolean {
  const results: Record<string, unknown>[] = []
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const step = parseStepLine(lines[index]!)
    if (!step) {
      return false
    }
    if (step.type === 'GENERIC') {
      results.unshift(step)
      continue
    }
    if (step.type !== 'PLANNER_RESPONSE') {
      return false
    }
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : []
    if (calls.length === 0) {
      return results.length === 0
    }
    const waitIndex = calls.findIndex((call) => isRecord(call) && call.name === 'swarm_wait')
    return (
      waitIndex !== -1 && results.length >= calls.length && results[waitIndex]?.status === 'DONE'
    )
  }
  return false
}

function isEndedOnReply(lines: readonly string[]): boolean {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const step = parseStepLine(lines[index]!)
    if (!step) {
      return false
    }
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : []
    return step.type === 'PLANNER_RESPONSE' && calls.length === 0
  }
  return false
}

export function extractAntigravityUserRequestText(content: string): string {
  const opener = '<USER_REQUEST>'
  const startIndex = content.indexOf(opener)
  if (startIndex === -1) {
    return content.trim()
  }
  const bodyStart = startIndex + opener.length
  const endIndex = content.indexOf('</USER_REQUEST>', bodyStart)
  return (endIndex === -1 ? content.slice(bodyStart) : content.slice(bodyStart, endIndex)).trim()
}

export function summarizeAntigravityTranscript(
  jsonlText: string,
  mtime: number,
  _now = Date.now()
): AntigravitySwarmTranscriptSummary {
  const lines = jsonlText.split('\n').filter((line) => line.trim().length > 0)
  let steps = lines.length
  let activity = ''
  let activityKind: 'tool' | 'thinking' | '' = ''
  let last: AntigravitySwarmTranscriptStepSummary | null = null

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const step = parseStepLine(lines[index]!)
    if (!step) {
      continue
    }
    if (index === lines.length - 1 && typeof step.step_index === 'number') {
      steps = Math.max(steps, step.step_index + 1)
    }
    if (!last) {
      last = {
        type: typeof step.type === 'string' ? step.type : '',
        status: typeof step.status === 'string' ? step.status : '',
        error: typeof step.error === 'string' ? oneLine(step.error, 240) : ''
      }
    }
    if (step.type === 'USER_INPUT') {
      break
    }
    if (step.type !== 'PLANNER_RESPONSE') {
      continue
    }
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : []
    if (calls.some((call) => isRecord(call) && call.name === 'swarm_wait')) {
      break
    }
    const labeled = calls.findLast((call) => Boolean(describeAntigravityToolCall(call)))
    const label = labeled ? describeAntigravityToolCall(labeled) : ''
    const heading = thinkingHeading(step.thinking)
    if (label) {
      activity = label
      activityKind = 'tool'
      break
    }
    if (heading) {
      activity = heading
      activityKind = 'thinking'
      break
    }
  }

  return {
    steps,
    activity,
    activityKind,
    last,
    idle: isTurnEnded(lines),
    replied: isEndedOnReply(lines),
    mtime
  }
}

export function parseAntigravityMemberTranscript(
  jsonlText: string
): AntigravitySwarmMemberTranscriptEntry[] {
  const entries: AntigravitySwarmMemberTranscriptEntry[] = []
  for (const line of jsonlText.split('\n')) {
    if (!line.trim()) {
      continue
    }
    const step = parseStepLine(line)
    if (!step) {
      continue
    }
    const stepIndex = typeof step.step_index === 'number' ? step.step_index : entries.length
    const timestamp = typeof step.created_at === 'string' ? step.created_at : undefined
    const source = typeof step.source === 'string' ? step.source : ''
    const type = typeof step.type === 'string' ? step.type : ''
    const content = typeof step.content === 'string' ? step.content : ''

    if ((source === 'USER_EXPLICIT' || source === 'USER') && type === 'USER_INPUT') {
      const text = extractAntigravityUserRequestText(content)
      if (text) {
        entries.push({
          stepIndex,
          kind: 'user',
          text,
          ...(timestamp ? { timestamp } : {}),
          toolCalls: []
        })
      }
      continue
    }

    if (type === 'ERROR_MESSAGE') {
      const errorText =
        (typeof step.error === 'string' && step.error.trim()) || content.trim() || 'Model error'
      entries.push({
        stepIndex,
        kind: 'error',
        text: errorText,
        ...(timestamp ? { timestamp } : {}),
        toolCalls: []
      })
      continue
    }

    if (source === 'MODEL' && type === 'PLANNER_RESPONSE') {
      const calls = Array.isArray(step.tool_calls) ? step.tool_calls : []
      const toolCalls: AntigravitySwarmToolCallSummary[] = calls.flatMap((call) => {
        if (!isRecord(call)) {
          return []
        }
        const name = typeof call.name === 'string' ? call.name : ''
        const label = describeAntigravityToolCall(call)
        return name ? [{ name, label: label || name }] : []
      })
      const thinking =
        typeof step.thinking === 'string' && step.thinking.trim() ? step.thinking : undefined
      if (!content.trim() && toolCalls.length === 0 && !thinking) {
        continue
      }
      entries.push({
        stepIndex,
        kind: 'assistant',
        text: content.trim(),
        ...(thinking ? { thinking } : {}),
        ...(timestamp ? { timestamp } : {}),
        toolCalls
      })
    }
  }
  return entries
}
