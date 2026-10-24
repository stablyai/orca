import { isDeepStrictEqual } from 'node:util'
import { isRecord } from '../../agent-status-child-work-value-guards'
import { readJsonlCursor, type JsonlCursor } from '../../codex-rollout-jsonl-cursor'
import type { AgentProcessIdentity } from '../../agent-process-presence'
import type { ClaudeLeadTurnState } from '../listener-state'

type Proof = 'complete' | 'pending' | 'lost'
type Verdict = 'working' | 'cancellation' | 'done'
export type ClaudePermissionObservation = {
  cursor: JsonlCursor
  sessionId: string
  launchToken?: string
  process?: AgentProcessIdentity
  toolName: string
  toolAgentType?: string
  input: unknown
  toolUseId?: string
  requiresUniqueInput: boolean
  promptId?: string
  descendants: Set<string>
  anchored: boolean
  result: boolean
  proof: Proof
  superseded?: boolean
  verdict: Verdict
  published?: Verdict
  lead?: ClaudeLeadTurnState
  failures: number
}

function rootRecord(row: Record<string, unknown>, sessionId: string): boolean {
  return (
    (row.isSidechain === false || (row.type === 'system' && row.isSidechain !== true)) &&
    (row.sessionId ?? row.session_id) === sessionId
  )
}

function blocks(row: Record<string, unknown>): Record<string, unknown>[] {
  return isRecord(row.message) && Array.isArray(row.message.content)
    ? row.message.content.filter(isRecord)
    : []
}

function bindRequest(
  observation: ClaudePermissionObservation,
  rows: Record<string, unknown>[],
  allowSettled: boolean
): number {
  const candidates: { id: string; uuid: string; index: number }[] = []
  const settled = new Set<string>()
  for (const [index, row] of rows.entries()) {
    if (!rootRecord(row, observation.sessionId)) {
      continue
    }
    for (const block of blocks(row)) {
      if (
        row.type === 'user' &&
        block.type === 'tool_result' &&
        typeof block.tool_use_id === 'string'
      ) {
        settled.add(block.tool_use_id)
      }
      if (
        row.type === 'assistant' &&
        block.type === 'tool_use' &&
        block.name === observation.toolName &&
        isDeepStrictEqual(block.input, observation.input) &&
        typeof block.id === 'string' &&
        typeof row.uuid === 'string'
      ) {
        candidates.push({ id: block.id, uuid: row.uuid, index })
      }
    }
  }
  const pending = candidates.filter((candidate) => !settled.has(candidate.id))
  // PreToolUse receipt order cannot identify two indistinguishable outstanding calls.
  if (
    observation.requiresUniqueInput &&
    (new Set(pending.map((candidate) => candidate.id)).size > 1 ||
      (observation.toolUseId &&
        pending.some((candidate) => candidate.id !== observation.toolUseId)))
  ) {
    return -1
  }
  // A late flush can contain both request and result; historical settled calls cannot identify a new wait.
  const eligible = allowSettled ? candidates : pending
  const ids = new Set(eligible.map((candidate) => candidate.id))
  const id = observation.toolUseId ?? (ids.size === 1 ? eligible[0]?.id : undefined)
  const anchor = candidates.findLast((candidate) => candidate.id === id)
  if (anchor) {
    observation.toolUseId = anchor.id
    observation.descendants.add(anchor.uuid)
    observation.anchored = true
    observation.proof = 'pending'
    return anchor.index
  }
  return -1
}

export function readClaudePermissionObservation(
  observation: ClaudePermissionObservation,
  allowSettled = true
): Proof | undefined {
  const lost = observation.proof === 'lost' && observation.anchored
  const rows = readJsonlCursor(observation.cursor, undefined, () => {
    allowSettled = false
    observation.proof = 'lost'
    observation.anchored = false
    observation.descendants.clear()
    observation.result = false
    observation.superseded = false
    observation.verdict = 'working'
  })
  if (!rows) {
    observation.failures++
    observation.proof = observation.failures >= 3 || lost ? 'lost' : 'pending'
    return
  }
  observation.failures = 0
  if (lost && observation.anchored) {
    return 'lost'
  }
  const start = observation.anchored ? 0 : bindRequest(observation, rows, allowSettled) + 1
  if (!observation.anchored) {
    return observation.proof
  }
  for (const row of rows.slice(start)) {
    if (!rootRecord(row, observation.sessionId) || typeof row.uuid !== 'string') {
      continue
    }
    const descends =
      typeof row.parentUuid === 'string' && observation.descendants.has(row.parentUuid)
    const content = blocks(row)
    const differentPrompt =
      observation.promptId !== undefined &&
      typeof row.promptId === 'string' &&
      row.promptId !== observation.promptId
    const interruption = content.some(
      (block) =>
        block.type === 'text' && block.text === '[Request interrupted by user for tool use]'
    )
    const userPrompt =
      row.type === 'user' &&
      row.isMeta !== true &&
      row.isCompactSummary !== true &&
      !interruption &&
      !content.some((block) => block.type === 'tool_result') &&
      ((isRecord(row.message) && typeof row.message.content === 'string') ||
        content.some((block) => block.type === 'text' && typeof block.text === 'string'))
    if (
      (descends || observation.result) &&
      (userPrompt ||
        (differentPrompt &&
          row.type === 'assistant' &&
          row.isMeta !== true &&
          row.isCompactSummary !== true &&
          content.length > 0))
    ) {
      observation.verdict = 'working'
      if (!descends) {
        observation.proof = 'lost'
        return 'lost'
      }
      observation.superseded = true
    }
    if (!descends) {
      continue
    }
    if (observation.descendants.size >= 512) {
      observation.proof = 'lost'
      return 'lost'
    }
    observation.descendants.add(row.uuid)
    if (
      row.type === 'user' &&
      content.some(
        (block) => block.type === 'tool_result' && block.tool_use_id === observation.toolUseId
      )
    ) {
      observation.promptId ??= typeof row.promptId === 'string' ? row.promptId : undefined
      observation.result = true
      observation.descendants.clear()
      observation.descendants.add(row.uuid)
    }
    if (differentPrompt || observation.superseded) {
      continue
    }
    if (!observation.result) {
      continue
    }
    if (
      row.type === 'user' &&
      observation.promptId !== undefined &&
      row.promptId === observation.promptId &&
      interruption
    ) {
      observation.verdict = 'cancellation'
    } else if (row.type === 'assistant' && content.length > 0) {
      observation.verdict = 'working'
    } else if (
      row.type === 'system' &&
      row.subtype === 'turn_duration' &&
      observation.verdict !== 'cancellation'
    ) {
      observation.verdict = 'done'
    }
  }
  observation.proof = observation.cursor.carry ? 'pending' : 'complete'
  return observation.proof
}
