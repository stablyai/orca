import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type {
  ClaudeTranscriptCursor,
  ClaudeTranscriptApplication
} from './claude-transcript-cursor'
import { isKnownHarnessInjectedUserTurnText } from '../../harness-injected-user-turns'

export type ClaudeHelperTranscriptEvidence = {
  observedAt: number
  killedAt?: number
  resumedAt: Map<string, number>
  launches: Map<string, number>
}
export type ClaudeChildTranscript = { cursor: ClaudeTranscriptCursor; promptedAt?: number }

function helperOperation(
  evidence: ClaudeHelperTranscriptEvidence,
  record: Record<string, unknown>,
  progress: ClaudeTranscriptApplication
): (() => void) | undefined {
  const index = progress.index
  const at = (progress.at ??=
    typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN)
  if (index === 0) {
    const killedAt =
      record.type === 'system' && record.subtype === 'agents_killed' && at >= evidence.observedAt
        ? Math.max(evidence.killedAt ?? 0, at)
        : evidence.killedAt
    return () => {
      evidence.killedAt = killedAt
    }
  }
  const content = messageContent(record)
  if (!Array.isArray(content) || index > content.length) {
    return undefined
  }
  const item = content[index - 1]
  if (isRecord(item)) {
    if (
      record.type === 'assistant' &&
      Number.isFinite(at) &&
      item.type === 'tool_use' &&
      (item.name === 'Agent' || item.name === 'Task') &&
      typeof item.id === 'string'
    ) {
      const id = item.id
      return () => {
        evidence.launches.set(id, at)
      }
    }
    if (
      record.type === 'user' &&
      item.type === 'tool_result' &&
      typeof item.tool_use_id === 'string'
    ) {
      const id = item.tool_use_id
      const started = evidence.launches.get(id)
      const result = record.toolUseResult
      const agentId =
        started !== undefined &&
        item.is_error !== true &&
        isRecord(result) &&
        result.isAsync === true &&
        typeof result.agentId === 'string'
          ? result.agentId
          : undefined
      const resumedAt =
        agentId !== undefined && started !== undefined
          ? Math.max(evidence.resumedAt.get(agentId) ?? 0, started)
          : undefined
      // Capture correlation and effect before deletion; retries repeat the same prepared values.
      return () => {
        evidence.launches.delete(id)
        if (agentId !== undefined && resumedAt !== undefined) {
          evidence.resumedAt.set(agentId, resumedAt)
        }
      }
    }
  }
  return () => {}
}

function childOperation(
  child: ClaudeChildTranscript,
  record: Record<string, unknown>,
  progress: ClaudeTranscriptApplication
): (() => void) | undefined {
  if (record.type !== 'user' || record.isMeta === true || record.isCompactSummary === true) {
    return undefined
  }
  const content = messageContent(record)
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content
  if (!Array.isArray(blocks)) {
    return undefined
  }
  if (progress.index < blocks.length) {
    const item = blocks[progress.index]
    const result = progress.result || (isRecord(item) && item.type === 'tool_result')
    const text =
      progress.text ||
      (isRecord(item) &&
        item.type === 'text' &&
        typeof item.text === 'string' &&
        item.text.trim() !== '' &&
        !isKnownHarnessInjectedUserTurnText(item.text))
    return () => {
      progress.result = result
      progress.text = text
    }
  }
  if (progress.index > blocks.length) {
    return undefined
  }
  const at = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN
  const promptedAt =
    progress.text && !progress.result && Number.isFinite(at)
      ? Math.max(child.promptedAt ?? 0, at)
      : child.promptedAt
  return () => {
    child.promptedAt = promptedAt
  }
}

function step(
  progress: ClaudeTranscriptApplication,
  prepare: () => (() => void) | undefined
): void {
  if (progress.complete) {
    return
  }
  progress.operation ??= prepare()
  if (!progress.operation) {
    progress.complete = true
    return
  }
  progress.operation()
  progress.operation = undefined
  progress.index++
}

async function applySteps(
  progress: ClaudeTranscriptApplication,
  prepare: () => (() => void) | undefined,
  current: () => boolean
): Promise<boolean> {
  let count = 0
  while (!progress.complete) {
    if (!current()) {
      return false
    }
    step(progress, prepare)
    if (++count % 512 === 0) {
      await yieldToEventLoop()
    }
  }
  return true
}

export function readClaudeHelperEvidence(
  evidence: ClaudeHelperTranscriptEvidence,
  records: Record<string, unknown>[]
): void {
  for (const record of records) {
    const progress: ClaudeTranscriptApplication = { index: 0 }
    while (!progress.complete) {
      step(progress, () => helperOperation(evidence, record, progress))
    }
  }
}
export function readClaudeChildPrompts(
  child: ClaudeChildTranscript,
  records: Record<string, unknown>[]
): void {
  for (const record of records) {
    const progress: ClaudeTranscriptApplication = { index: 0 }
    while (!progress.complete) {
      step(progress, () => childOperation(child, record, progress))
    }
  }
}
export async function applyClaudeHelperEvidence(
  evidence: ClaudeHelperTranscriptEvidence,
  record: Record<string, unknown>,
  current: () => boolean,
  progress: ClaudeTranscriptApplication
): Promise<boolean> {
  return applySteps(progress, () => helperOperation(evidence, record, progress), current)
}
export async function applyClaudeChildPrompt(
  child: ClaudeChildTranscript,
  record: Record<string, unknown>,
  current: () => boolean,
  progress: ClaudeTranscriptApplication
): Promise<boolean> {
  return applySteps(progress, () => childOperation(child, record, progress), current)
}
function messageContent(record: Record<string, unknown>): unknown {
  return isRecord(record.message) ? record.message.content : undefined
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
