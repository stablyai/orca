import { dirname, join } from 'node:path'
import { isRecord } from '../../../agent-status/child-work/agent-status-child-work-value-guards'
import { readFirstString } from '../../interactive-tool'
import { parseAgentHookJson } from '../../request-body'
import { readJsonlCursorBytes, type RolloutReadBatch } from '../codex/codex-rollout-async-reads'
import { applyJsonlCursorBytes } from '../codex/codex-rollout-jsonl-format'
import { extractAntigravityToolFields } from './antigravity-tool-fields'
import {
  normalizeAntigravityModel,
  type AntigravityBrainCache,
  type AntigravityChildTranscriptTail
} from './antigravity-brain-metadata'

function unwrapCompactTranscriptArgs(rawArgs: unknown): unknown {
  if (!isRecord(rawArgs)) {
    return rawArgs
  }
  const unwrapped: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(rawArgs)) {
    if (
      typeof value === 'string' &&
      value.length >= 2 &&
      value.startsWith('"') &&
      value.endsWith('"')
    ) {
      try {
        const parsed = parseAgentHookJson(value)
        unwrapped[key] = typeof parsed === 'string' ? parsed : value
        continue
      } catch {
        // Keep raw string when not a JSON-quoted scalar.
      }
    }
    unwrapped[key] = value
  }
  return unwrapped
}

function childTranscriptFilePath(rootBrainDir: string, childId: string): string | undefined {
  if (!childId || childId.includes('/') || childId.includes('\\') || childId.includes('..')) {
    return undefined
  }
  return join(dirname(rootBrainDir), childId, '.system_generated', 'logs', 'transcript.jsonl')
}

export async function readAntigravityChildTranscriptTail(
  rootBrainDir: string,
  childId: string,
  cache: AntigravityBrainCache,
  batch: RolloutReadBatch
): Promise<AntigravityChildTranscriptTail | undefined> {
  const childTranscriptPath = childTranscriptFilePath(rootBrainDir, childId)
  if (!childTranscriptPath) {
    return undefined
  }
  const previous = cache.transcripts.get(childTranscriptPath) ?? {
    cursor: { filePath: childTranscriptPath, offset: 0, carry: '' }
  }
  const read = await readJsonlCursorBytes(previous.cursor, batch)
  if (read === 'deferred') {
    return previous.tail
  }
  const records = applyJsonlCursorBytes(previous.cursor, read)
  if (!records || records === 'stale') {
    return undefined
  }
  for (const parsed of records) {
    const createdAt =
      typeof parsed.created_at === 'string' ? Date.parse(parsed.created_at) : Number.NaN
    if (Number.isFinite(createdAt)) {
      previous.startedAt ??= createdAt
    }
    previous.model = normalizeAntigravityModel(parsed.model) ?? previous.model
    const toolCalls = Array.isArray(parsed.tool_calls) ? parsed.tool_calls : []
    const firstCall = isRecord(toolCalls[0]) ? toolCalls[0] : undefined
    const tool = firstCall
      ? extractAntigravityToolFields('PreToolUse', {
          toolCall: {
            name: readFirstString(firstCall, ['name', 'toolName', 'tool_name']),
            args: unwrapCompactTranscriptArgs(firstCall.args)
          }
        })
      : undefined
    previous.tail = {
      settled:
        parsed.type === 'PLANNER_RESPONSE' &&
        ['DONE', 'ERROR', 'CANCELLED'].includes(String(parsed.status)) &&
        toolCalls.length === 0,
      stepIndex: typeof parsed.step_index === 'number' ? parsed.step_index : undefined,
      model: previous.model,
      toolName: tool?.toolName,
      toolInput: tool?.toolInput,
      createdAtMs: previous.startedAt
    }
  }
  cache.transcripts.set(childTranscriptPath, previous)
  return previous.tail
}
