import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import {
  isTextBlock,
  type AgentType,
  type NativeChatMessage,
  type NativeChatSessionMetadata
} from '../../../../shared/native-chat-types'

export type NativeChatStatusFooterData = {
  primary: string[]
  stage: string
  next: string
  questions: number
  blocked: number
  agents: number
}

export type NativeChatStatusFooterInput = {
  agent: AgentType
  metadata?: NativeChatSessionMetadata
  messages: readonly NativeChatMessage[]
  agentStatus?: AgentStatusEntry
  worktreeName?: string
  changedFiles?: number
}

type ParsedStageLine = {
  stage: string
  next: string
  questions: number
  blocked: number
  agents: number
}

export function deriveNativeChatStatusFooter(
  input: NativeChatStatusFooterInput
): NativeChatStatusFooterData {
  const parsed = findLatestStageLine(input)
  const liveQuestions = countInteractiveQuestions(input.agentStatus?.interactivePrompt)
  const liveAgents = input.agentStatus?.subagents?.filter(
    (entry) => entry.state === 'working'
  ).length
  const liveBlocked = input.agentStatus?.state === 'blocked' ? 1 : 0
  const fallback = fallbackStage(input.agentStatus?.state)

  return {
    primary: primarySegments(input),
    stage: parsed?.stage ?? fallback.stage,
    next: parsed?.next ?? fallback.next,
    questions: liveQuestions ?? parsed?.questions ?? 0,
    blocked: Math.max(liveBlocked, parsed?.blocked ?? 0),
    agents: liveAgents ?? parsed?.agents ?? 0
  }
}

export function nativeChatWorktreeName(pathValue: string | undefined): string | undefined {
  return pathValue?.split(/[\\/]/).toReversed().find(Boolean)
}

function primarySegments(input: NativeChatStatusFooterInput): string[] {
  const metadata = input.metadata
  const segments = [metadata?.model ?? input.agent]
  if (metadata?.reasoningEffort) {
    segments.push(metadata.reasoningEffort)
  }
  if (metadata?.contextTokens !== undefined) {
    const context = compactNumber(metadata.contextTokens)
    segments.push(
      metadata.contextWindowTokens !== undefined
        ? `${context}/${compactNumber(metadata.contextWindowTokens)}`
        : context
    )
  }
  if (input.worktreeName) {
    const dirty = input.changedFiles && input.changedFiles > 0 ? ` +${input.changedFiles}` : ''
    segments.push(`${input.worktreeName}${dirty}`)
  }
  if (metadata?.sessionLimitUsedPercent !== undefined) {
    segments.push(`5h ${compactPercent(metadata.sessionLimitUsedPercent)}`)
  }
  if (metadata?.weeklyLimitUsedPercent !== undefined) {
    segments.push(`7d ${compactPercent(metadata.weeklyLimitUsedPercent)}`)
  }
  return segments
}

function compactNumber(value: number): string {
  const absolute = Math.abs(value)
  if (absolute >= 1_000_000) {
    return `${formatDecimal(value / 1_000_000)}M`
  }
  if (absolute >= 1_000) {
    return `${formatDecimal(value / 1_000)}k`
  }
  return Math.round(value).toString()
}

function formatDecimal(value: number): string {
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, '')
}

function compactPercent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(100, value)))}%`
}

function findLatestStageLine(input: NativeChatStatusFooterInput): ParsedStageLine | null {
  const candidates = [
    input.agentStatus?.lastAssistantMessage,
    ...input.messages
      .filter((message) => message.role === 'assistant')
      .toReversed()
      .map((message) =>
        message.blocks
          .filter(isTextBlock)
          .map((block) => block.text)
          .join('\n')
      )
  ]
  for (const candidate of candidates) {
    if (!candidate) {
      continue
    }
    const lines = candidate.split(/\r?\n/).toReversed()
    for (const line of lines) {
      const parsed = parseStageLine(line.trim())
      if (parsed) {
        return parsed
      }
    }
  }
  return null
}

function parseStageLine(line: string): ParsedStageLine | null {
  const match = /^(?:этап|stage):\s*(.*?)\s*(?:→|->)\s*(.*?)(?:\s*·|$)/i.exec(line)
  if (!match?.[1] || !match[2]) {
    return null
  }
  return {
    stage: match[1].trim(),
    next: match[2].trim(),
    questions: readCount(line, /(?:Q\s*:|вопросов\s*:?)\s*(\d+)/i),
    blocked: readCount(line, /(?:B\s*:|blocked\s*:?)\s*(\d+)/i),
    agents: readCount(line, /(?:Ag\s*:|agents\s*:?|агентов\s*:?)\s*(\d+)/i)
  }
}

function readCount(line: string, pattern: RegExp): number {
  const value = pattern.exec(line)?.[1]
  return value ? Number.parseInt(value, 10) : 0
}

function countInteractiveQuestions(value: string | undefined): number | null {
  if (!value) {
    return null
  }
  try {
    const parsed = JSON.parse(value) as { questions?: unknown }
    return Array.isArray(parsed.questions) ? parsed.questions.length : 1
  } catch {
    return 1
  }
}

function fallbackStage(state: AgentStatusEntry['state'] | undefined): {
  stage: string
  next: string
} {
  switch (state) {
    case undefined:
    case 'working':
      return { stage: 'working', next: 'next agent update' }
    case 'blocked':
      return { stage: 'blocked', next: 'operator action' }
    case 'waiting':
      return { stage: 'waiting', next: 'agent continuation' }
    case 'done':
      return { stage: 'done', next: 'next request' }
  }
}
