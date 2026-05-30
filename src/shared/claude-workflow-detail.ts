/* eslint-disable max-lines -- Why: this module keeps the public detail IPC
   contract, bounded preview reader, and tolerant Claude JSONL extraction in
   one place so security caps and warning semantics stay in lockstep. */
import type {
  AgentStateHistoryEntry,
  AgentStatusOrchestrationContext,
  AgentStatusState
} from './agent-status-types'
import { isPathInsideOrEqual } from './cross-platform-path'

export type ClaudeWorkflowFileSelectors = {
  transcriptPath?: string
  scriptPath?: string
  cwd?: string
  sessionId?: string
}

export type ClaudeWorkflowDetailTarget = {
  paneKey: string
  worktreeId: string
  connectionId: string | null
  worktreePath: string
  state: AgentStatusState | 'idle'
  prompt: string
  updatedAt: number
  stateStartedAt: number
  stateHistory: AgentStateHistoryEntry[]
  agentType?: string
  terminalTitle?: string
  orchestration?: AgentStatusOrchestrationContext
  selectors?: ClaudeWorkflowFileSelectors
  tabTitle?: string
}

export type ClaudeWorkflowPreview = {
  path?: string
  content: string
  truncated: boolean
  binary: boolean
  bytesRead: number
}

export type ClaudeWorkflowTimelineItem = {
  id: string
  label: string
  state?: AgentStatusState | 'idle'
  startedAt?: number
  endedAt?: number
  durationMs?: number
  detail?: string
}

export type ClaudeWorkflowAgentDetail = {
  id: string
  label: string
  state: AgentStatusState | 'unknown'
  prompt?: string
  lastMessage?: string
  transcriptPreview?: string
  tokenCount?: number
}

export type ClaudeWorkflowMetrics = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  costUsd?: number
  elapsedMs?: number
}

export type ClaudeWorkflowDetail = {
  target: ClaudeWorkflowDetailTarget
  summaryOnly: boolean
  source: 'local' | 'remote-unsupported' | 'summary-only'
  warnings: string[]
  mtimeMs?: number
  timeline: ClaudeWorkflowTimelineItem[]
  agents: ClaudeWorkflowAgentDetail[]
  transcriptPreview?: ClaudeWorkflowPreview
  scriptPreview?: ClaudeWorkflowPreview
  metrics?: ClaudeWorkflowMetrics
}

export type ClaudeWorkflowDetailRequest = {
  target: ClaudeWorkflowDetailTarget
}

export const CLAUDE_WORKFLOW_TRANSCRIPT_PREVIEW_BYTES = 96 * 1024
export const CLAUDE_WORKFLOW_SCRIPT_PREVIEW_BYTES = 32 * 1024
export const CLAUDE_WORKFLOW_TOTAL_PREVIEW_BYTES = 128 * 1024
export const CLAUDE_WORKFLOW_AGENT_PREVIEW_LIMIT = 40

type ReadPreviewResult = {
  content: string
  bytesRead: number
  truncated: boolean
  mtimeMs?: number
}

export type ClaudeWorkflowDetailReaderIo = {
  readPreview: (filePath: string, maxBytes: number) => Promise<ReadPreviewResult>
  stat: (filePath: string) => Promise<{ mtimeMs: number; size: number }>
}

function compactText(value: unknown, maxLength = 500): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const compacted = value.trim().replace(/[\r\n\u2028\u2029]+/g, ' ')
  if (!compacted) {
    return undefined
  }
  return compacted.length > maxLength ? `${compacted.slice(0, maxLength - 1)}…` : compacted
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim()
    }
  }
  return undefined
}

function extractTextFromContent(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return compactText(content, 800)
  }
  if (!Array.isArray(content)) {
    return undefined
  }
  const parts: string[] = []
  for (const part of content) {
    if (!isRecord(part)) {
      continue
    }
    const text = compactText(part.text ?? part.content, 300)
    if (text) {
      parts.push(text)
    }
  }
  return compactText(parts.join(' '), 800)
}

function extractMessageText(record: Record<string, unknown>): string | undefined {
  const direct = extractTextFromContent(record.content)
  if (direct) {
    return direct
  }
  const message = record.message
  if (isRecord(message)) {
    return extractTextFromContent(message.content)
  }
  return undefined
}

function addUsage(metrics: ClaudeWorkflowMetrics, usage: unknown): void {
  if (!isRecord(usage)) {
    return
  }
  const input =
    typeof usage.input_tokens === 'number'
      ? usage.input_tokens
      : typeof usage.inputTokens === 'number'
        ? usage.inputTokens
        : 0
  const output =
    typeof usage.output_tokens === 'number'
      ? usage.output_tokens
      : typeof usage.outputTokens === 'number'
        ? usage.outputTokens
        : 0
  if (input > 0) {
    metrics.inputTokens = (metrics.inputTokens ?? 0) + input
  }
  if (output > 0) {
    metrics.outputTokens = (metrics.outputTokens ?? 0) + output
  }
  const cost = typeof usage.cost_usd === 'number' ? usage.cost_usd : usage.costUsd
  if (typeof cost === 'number' && Number.isFinite(cost)) {
    metrics.costUsd = (metrics.costUsd ?? 0) + cost
  }
}

function extractTimestamp(record: Record<string, unknown>): number | undefined {
  const value = record.timestamp ?? record.created_at ?? record.createdAt
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function detectBinaryLooking(content: string): boolean {
  if (content.includes('\0')) {
    return true
  }
  const sample = content.slice(0, 4096)
  if (!sample) {
    return false
  }
  let control = 0
  for (let i = 0; i < sample.length; i += 1) {
    const code = sample.charCodeAt(i)
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      control += 1
    }
  }
  return control / sample.length > 0.08
}

function safeSelectorPath(
  worktreePath: string,
  candidatePath: string | undefined,
  warnings: string[],
  label: string
): string | undefined {
  if (!candidatePath) {
    return undefined
  }
  if (candidatePath.includes('\0') || !isPathInsideOrEqual(worktreePath, candidatePath)) {
    warnings.push(`${label} is outside the selected worktree and was not read.`)
    return undefined
  }
  return candidatePath
}

function initialTimeline(target: ClaudeWorkflowDetailTarget): ClaudeWorkflowTimelineItem[] {
  const history = [
    ...target.stateHistory,
    { state: target.state, prompt: target.prompt, startedAt: target.stateStartedAt }
  ]
  return history.map((entry, index) => {
    const next = history[index + 1]
    const startedAt = entry.startedAt
    const endedAt = next?.startedAt
    return {
      id: `${target.paneKey}:${index}`,
      label: entry.prompt.trim() || entry.state,
      state: entry.state,
      startedAt,
      endedAt,
      durationMs: endedAt && startedAt ? Math.max(0, endedAt - startedAt) : undefined
    }
  })
}

function parseTranscript(
  text: string,
  target: ClaudeWorkflowDetailTarget,
  warnings: string[]
): {
  agents: ClaudeWorkflowAgentDetail[]
  metrics: ClaudeWorkflowMetrics
  scriptPath?: string
  firstTimestamp?: number
  lastTimestamp?: number
} {
  const agents = new Map<string, ClaudeWorkflowAgentDetail>()
  const metrics: ClaudeWorkflowMetrics = {}
  let malformed = 0
  let firstTimestamp: number | undefined
  let lastTimestamp: number | undefined
  let scriptPath: string | undefined

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      malformed += 1
      continue
    }
    if (!isRecord(parsed)) {
      continue
    }
    const timestamp = extractTimestamp(parsed)
    if (timestamp !== undefined) {
      firstTimestamp =
        firstTimestamp === undefined ? timestamp : Math.min(firstTimestamp, timestamp)
      lastTimestamp = lastTimestamp === undefined ? timestamp : Math.max(lastTimestamp, timestamp)
    }
    addUsage(metrics, parsed.usage)
    if (isRecord(parsed.message)) {
      addUsage(metrics, parsed.message.usage)
    }

    const content = isRecord(parsed.message) ? parsed.message.content : parsed.content
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!isRecord(part)) {
          continue
        }
        const name = readString(part, ['name'])
        const input = isRecord(part.input) ? part.input : undefined
        const partId = readString(part, ['id', 'tool_use_id', 'toolUseId'])
        if (name === 'Task' || name === 'delegate_task') {
          const id = partId ?? `agent-${agents.size + 1}`
          const prompt = input ? compactText(input.prompt, 900) : undefined
          agents.set(id, {
            id,
            label:
              (input && compactText(input.description ?? input.subagent_type, 120)) ?? 'Subagent',
            state: 'working',
            prompt,
            transcriptPreview: prompt
          })
        }
        const candidateScriptPath =
          input && readString(input, ['scriptPath', 'script_path', 'generatedScriptPath', 'path'])
        if (!scriptPath && candidateScriptPath && /\.(?:m?js|cjs)$/i.test(candidateScriptPath)) {
          scriptPath = candidateScriptPath
        }
      }
    }

    const toolUseId = readString(parsed, ['tool_use_id', 'toolUseId'])
    if (toolUseId && agents.has(toolUseId)) {
      const current = agents.get(toolUseId)!
      agents.set(toolUseId, {
        ...current,
        state: 'done',
        lastMessage: extractMessageText(parsed) ?? current.lastMessage
      })
    }
  }

  if (malformed > 0) {
    warnings.push(`${malformed} malformed transcript line${malformed === 1 ? '' : 's'} skipped.`)
  }
  if (target.prompt.trim() && agents.size === 0) {
    agents.set(target.paneKey, {
      id: target.paneKey,
      label: target.terminalTitle || 'Claude turn',
      state: target.state === 'idle' ? 'unknown' : target.state,
      prompt: target.prompt
    })
  }
  metrics.totalTokens = (metrics.inputTokens ?? 0) + (metrics.outputTokens ?? 0) || undefined
  if (
    firstTimestamp !== undefined &&
    lastTimestamp !== undefined &&
    lastTimestamp >= firstTimestamp
  ) {
    metrics.elapsedMs = lastTimestamp - firstTimestamp
  }
  return {
    agents: [...agents.values()].slice(0, CLAUDE_WORKFLOW_AGENT_PREVIEW_LIMIT),
    metrics,
    scriptPath,
    firstTimestamp,
    lastTimestamp
  }
}

export async function readClaudeWorkflowDetail(
  target: ClaudeWorkflowDetailTarget,
  io: ClaudeWorkflowDetailReaderIo | null
): Promise<ClaudeWorkflowDetail> {
  const warnings: string[] = []
  const timeline = initialTimeline(target)
  if (target.connectionId && !io) {
    warnings.push(
      'Remote workflow detail reads are not supported in this build; showing row summary only.'
    )
    return {
      target,
      summaryOnly: true,
      source: 'remote-unsupported',
      warnings,
      timeline,
      agents: [],
      metrics: undefined
    }
  }
  if (!io) {
    warnings.push('No workflow file reader is available; showing row summary only.')
    return {
      target,
      summaryOnly: true,
      source: 'summary-only',
      warnings,
      timeline,
      agents: [],
      metrics: undefined
    }
  }

  const transcriptPath = safeSelectorPath(
    target.worktreePath,
    target.selectors?.transcriptPath,
    warnings,
    'Transcript path'
  )
  if (!transcriptPath) {
    warnings.push('No Claude workflow transcript was discovered for this row.')
    return {
      target,
      summaryOnly: true,
      source: 'summary-only',
      warnings,
      timeline,
      agents: [],
      metrics: undefined
    }
  }

  let transcript: ReadPreviewResult
  try {
    transcript = await io.readPreview(transcriptPath, CLAUDE_WORKFLOW_TRANSCRIPT_PREVIEW_BYTES)
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : 'Could not read Claude transcript.')
    return {
      target,
      summaryOnly: true,
      source: 'summary-only',
      warnings,
      timeline,
      agents: [],
      metrics: undefined
    }
  }

  const transcriptPreview: ClaudeWorkflowPreview = {
    path: transcriptPath,
    content: transcript.content,
    truncated: transcript.truncated,
    binary: detectBinaryLooking(transcript.content),
    bytesRead: transcript.bytesRead
  }
  if (transcriptPreview.binary) {
    transcriptPreview.content = ''
    warnings.push('Transcript preview looked binary and was hidden.')
  }
  if (transcript.truncated) {
    warnings.push('Transcript preview was truncated.')
  }

  const parsed = transcriptPreview.binary
    ? { agents: [], metrics: {}, scriptPath: undefined }
    : parseTranscript(transcript.content, target, warnings)
  let scriptPath = safeSelectorPath(
    target.worktreePath,
    target.selectors?.scriptPath ?? parsed.scriptPath,
    warnings,
    'Script path'
  )
  let scriptPreview: ClaudeWorkflowPreview | undefined
  let mtimeMs = transcript.mtimeMs
  if (scriptPath) {
    try {
      const script = await io.readPreview(scriptPath, CLAUDE_WORKFLOW_SCRIPT_PREVIEW_BYTES)
      const binary = detectBinaryLooking(script.content)
      scriptPreview = {
        path: scriptPath,
        content: binary ? '' : script.content,
        truncated: script.truncated,
        binary,
        bytesRead: script.bytesRead
      }
      if (binary) {
        warnings.push('Script preview looked binary and was hidden.')
      }
      if (script.truncated) {
        warnings.push('Script preview was truncated.')
      }
      mtimeMs = Math.max(mtimeMs ?? 0, script.mtimeMs ?? 0) || mtimeMs
    } catch (error) {
      scriptPath = undefined
      warnings.push(error instanceof Error ? error.message : 'Could not read generated script.')
    }
  }

  return {
    target,
    summaryOnly: false,
    source: 'local',
    warnings,
    mtimeMs,
    timeline,
    agents: parsed.agents,
    transcriptPreview,
    scriptPreview,
    metrics: parsed.metrics
  }
}
