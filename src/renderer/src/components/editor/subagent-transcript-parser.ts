export type SubagentStepType =
  | 'USER_INPUT'
  | 'THINKING'
  | 'TOOL_CALL'
  | 'MODEL_RESPONSE'
  | 'SYSTEM'
  | 'ERROR'

export type SubagentStepStatus = 'done' | 'error' | 'in_progress'

export type SubagentTranscriptStep = {
  id: string
  type: SubagentStepType
  status: SubagentStepStatus
  timestamp?: string
  content?: string
  toolName?: string
  toolUseId?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  searchCorpus?: string
  rawLine?: string
}

import { extractToolResultContent, safeJsonStringify } from './subagent-transcript-text'

export function isSubagentLogPath(filePath: string): boolean {
  if (!filePath || typeof filePath !== 'string') {
    return false
  }
  const lower = filePath.toLowerCase()
  return lower.includes('/subagents/agent-') || lower.includes('\\subagents\\agent-')
}

export function parseSubagentJsonlTranscript(rawContent: string): SubagentTranscriptStep[] {
  if (!rawContent || !rawContent.trim()) {
    return []
  }

  const rawLines = rawContent.split('\n')
  const hasTrailingNewline = rawContent.endsWith('\n') || rawContent.endsWith('\r')
  const linesWithMeta = rawLines
    .map((l, index) => ({ line: l.trim(), isLast: index === rawLines.length - 1 }))
    .filter((l) => l.line.length > 0)

  const steps: SubagentTranscriptStep[] = []
  let stepCounter = 0

  for (const { line, isLast } of linesWithMeta) {
    let parsed: Record<string, unknown> | null = null
    try {
      parsed = JSON.parse(line) as Record<string, unknown>
    } catch {
      // If parsing fails on an incomplete last line during live tailing, skip it until completed
      if (isLast && !hasTrailingNewline) {
        continue
      }
      steps.push({
        id: `step-${++stepCounter}`,
        type: 'SYSTEM',
        status: 'done',
        content: line,
        searchCorpus: line.toLowerCase(),
        rawLine: line
      })
      continue
    }

    if (!parsed || typeof parsed !== 'object') {
      continue
    }

    const timestamp =
      typeof parsed.timestamp === 'string'
        ? parsed.timestamp
        : typeof parsed.created_at === 'string'
          ? parsed.created_at
          : typeof parsed.time === 'string'
            ? parsed.time
            : undefined

    // 1. Process standard Claude JSONL format with `message`
    if (parsed.message && typeof parsed.message === 'object') {
      const msgObj = parsed.message as Record<string, unknown>
      const role =
        typeof msgObj.role === 'string'
          ? msgObj.role
          : typeof parsed.role === 'string'
            ? parsed.role
            : String(parsed.type || '')
      const contents = Array.isArray(msgObj.content)
        ? (msgObj.content as Record<string, unknown>[])
        : [{ type: 'text', text: msgObj.content }]

      for (const item of contents) {
        if (!item || typeof item !== 'object') {
          continue
        }

        if (item.type === 'thinking' || item.thinking) {
          const content = String(item.thinking || item.text || '')
          steps.push({
            id: `step-${++stepCounter}`,
            type: 'THINKING',
            status: 'done',
            timestamp,
            content,
            searchCorpus: content.toLowerCase(),
            rawLine: line
          })
        } else if (item.type === 'tool_use' || item.name) {
          const toolName = String(item.name || item.toolName || 'tool')
          const toolUseId = typeof item.id === 'string' ? item.id : undefined
          const toolArgs = (item.input || item.args || {}) as Record<string, unknown>
          const corpus = `${toolName} ${safeJsonStringify(toolArgs)}`.toLowerCase()

          steps.push({
            id: `step-${++stepCounter}`,
            type: 'TOOL_CALL',
            status: 'done',
            timestamp,
            toolName,
            toolUseId,
            toolArgs,
            searchCorpus: corpus,
            rawLine: line
          })
        } else if (item.type === 'tool_result') {
          const isError = item.is_error === true
          const toolUseId = typeof item.tool_use_id === 'string' ? item.tool_use_id : undefined
          const resultStr = extractToolResultContent(item.content)

          let matchedToolCall: SubagentTranscriptStep | undefined
          if (toolUseId) {
            matchedToolCall = steps.find((s) => s.type === 'TOOL_CALL' && s.toolUseId === toolUseId)
          }

          if (!matchedToolCall) {
            for (let i = steps.length - 1; i >= 0; i--) {
              if (steps[i].type === 'TOOL_CALL' && !steps[i].toolResult) {
                matchedToolCall = steps[i]
                break
              }
            }
          }

          if (matchedToolCall) {
            matchedToolCall.toolResult = resultStr
            if (isError) {
              matchedToolCall.status = 'error'
            }
            matchedToolCall.searchCorpus = `${matchedToolCall.searchCorpus || ''} ${resultStr.toLowerCase()}`
          } else {
            steps.push({
              id: `step-${++stepCounter}`,
              type: 'TOOL_CALL',
              status: isError ? 'error' : 'done',
              timestamp,
              toolName: 'tool_result',
              toolUseId,
              toolResult: resultStr,
              searchCorpus: resultStr.toLowerCase(),
              rawLine: line
            })
          }
        } else if (item.type === 'text' && item.text) {
          const stepType = role === 'user' ? 'USER_INPUT' : 'MODEL_RESPONSE'
          const content = String(item.text)
          steps.push({
            id: `step-${++stepCounter}`,
            type: stepType,
            status: 'done',
            timestamp,
            content,
            searchCorpus: content.toLowerCase(),
            rawLine: line
          })
        }
      }
      continue
    }

    // 2. Direct Step Format
    const typeUpper = String(parsed.type || parsed.role || 'SYSTEM').toUpperCase()

    if (typeUpper === 'USER_INPUT' || typeUpper === 'USER' || typeUpper === 'HUMAN') {
      const content = String(parsed.content || parsed.text || parsed.message || '')
      steps.push({
        id: `step-${++stepCounter}`,
        type: 'USER_INPUT',
        status: 'done',
        timestamp,
        content,
        searchCorpus: content.toLowerCase(),
        rawLine: line
      })
    } else if (typeUpper === 'THINKING') {
      const content = String(parsed.content || parsed.text || parsed.thinking || '')
      steps.push({
        id: `step-${++stepCounter}`,
        type: 'THINKING',
        status: 'done',
        timestamp,
        content,
        searchCorpus: content.toLowerCase(),
        rawLine: line
      })
    } else if (typeUpper === 'TOOL_CALL' || parsed.toolName || parsed.tool_name) {
      const toolName = String(parsed.toolName || parsed.tool_name || parsed.name || 'tool')
      const toolUseId =
        typeof parsed.id === 'string'
          ? parsed.id
          : typeof parsed.tool_use_id === 'string'
            ? parsed.tool_use_id
            : undefined
      const toolArgs = (parsed.toolArgs || parsed.args || parsed.input || {}) as Record<
        string,
        unknown
      >
      const rawResult = parsed.toolResult || parsed.result || parsed.output
      const toolResult = rawResult !== undefined ? extractToolResultContent(rawResult) : undefined
      const corpus = `${toolName} ${safeJsonStringify(toolArgs)} ${toolResult || ''}`.toLowerCase()

      steps.push({
        id: `step-${++stepCounter}`,
        type: 'TOOL_CALL',
        status: parsed.status === 'error' || parsed.isError ? 'error' : 'done',
        timestamp,
        toolName,
        toolUseId,
        toolArgs,
        toolResult,
        searchCorpus: corpus,
        rawLine: line
      })
    } else if (typeUpper === 'MODEL_RESPONSE' || typeUpper === 'ASSISTANT') {
      const content = String(parsed.content || parsed.text || '')
      steps.push({
        id: `step-${++stepCounter}`,
        type: 'MODEL_RESPONSE',
        status: 'done',
        timestamp,
        content,
        searchCorpus: content.toLowerCase(),
        rawLine: line
      })
    } else if (typeUpper === 'ERROR') {
      const content = String(parsed.message || parsed.error || parsed.content || line)
      steps.push({
        id: `step-${++stepCounter}`,
        type: 'ERROR',
        status: 'error',
        timestamp,
        content,
        searchCorpus: content.toLowerCase(),
        rawLine: line
      })
    } else {
      const content =
        typeof parsed.content === 'string' ? parsed.content : safeJsonStringify(parsed)
      steps.push({
        id: `step-${++stepCounter}`,
        type: 'SYSTEM',
        status: 'done',
        timestamp,
        content,
        searchCorpus: content.toLowerCase(),
        rawLine: line
      })
    }
  }

  return steps
}
