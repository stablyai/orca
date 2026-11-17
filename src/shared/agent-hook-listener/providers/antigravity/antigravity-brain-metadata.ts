import { dirname, join } from 'node:path'

import { readPathFromKeys } from '../../../agent-session/lifecycle/agent-session-resume'
import { isRecord } from '../../../agent-status/child-work/agent-status-child-work-value-guards'
import {
  AGENT_MODEL_MAX_LENGTH,
  normalizeOptionalField
} from '../../../agent-status/contracts/agent-status-field-normalization'
import { readNodeFileSyncWithinLimit } from '../../../file-content/node-bounded-file-reader'
import { readFirstString } from '../../interactive-tool'
import { parseAgentHookJson } from '../../request-body'
import { readFirstTranscriptRecord, readLastTextFromTranscriptOnce } from '../../transcript-reader'
import { readTranscriptDirectory } from '../codex/codex-rollout-jsonl-cursor'
import { extractAntigravityToolFields } from './antigravity-tool-fields'

const BRAIN_METADATA_MAX_BYTES = 256 * 1024
const BRAIN_CACHE_MAX_ENTRIES = 256
const TRANSCRIPT_SUFFIX_RE = /[\\/]\.system_generated[\\/]logs[\\/]transcript(?:_full)?\.jsonl$/

export type AntigravityTranscriptOrigin = 'root' | 'child' | 'unknown'

export type AntigravityDiskSubagent = {
  conversationId: string
  state: string
  typeName?: string
  role?: string
  mtimeMs: number
}

export type AntigravityDiskSwarmMember = {
  name: string
  conversationId: string
  role?: string
  phase?: string
  desiredState?: string
  wakeMode?: string
  killed: boolean
  model?: string
}

export type AntigravityChildTranscriptTail = {
  settled: boolean
  stepIndex?: number
  model?: string
  toolName?: string
  toolInput?: string
  createdAtMs?: number
}

export type AntigravityBrainCache = {
  jsonFiles: Map<string, { mtimeMs: number; size: number; parsed: Record<string, unknown> | null }>
}

export function createAntigravityBrainCache(): AntigravityBrainCache {
  return { jsonFiles: new Map() }
}

export function resolveAntigravityBrainDirectory(
  hookPayload: Record<string, unknown>,
  transcriptPath: string | undefined
): string | undefined {
  const artifactDir = readPathFromKeys(hookPayload, [
    'artifactDirectoryPath',
    'artifact_directory_path'
  ])
  if (artifactDir) {
    return artifactDir
  }
  if (!transcriptPath || !TRANSCRIPT_SUFFIX_RE.test(transcriptPath)) {
    return undefined
  }
  const stripped = transcriptPath.replace(TRANSCRIPT_SUFFIX_RE, '')
  return stripped.length > 0 ? stripped : undefined
}

export function classifyAntigravityTranscriptOrigin(
  transcriptPath: string | undefined
): AntigravityTranscriptOrigin {
  if (!transcriptPath) {
    return 'unknown'
  }
  const origin = readFirstTranscriptRecord(transcriptPath)
  if (!isRecord(origin)) {
    return 'unknown'
  }
  if (origin.source === 'USER_EXPLICIT' && origin.type === 'USER_INPUT') {
    return 'root'
  }
  if (origin.source === 'SYSTEM' && origin.type === 'SYSTEM_MESSAGE') {
    return 'child'
  }
  return 'unknown'
}

export function normalizeAntigravityModel(raw: unknown): string | undefined {
  const normalized = normalizeOptionalField(raw, AGENT_MODEL_MAX_LENGTH)
  if (!normalized || normalized.toLowerCase() === 'auto') {
    return undefined
  }
  return normalized
}

export function readAntigravityTranscriptModel(
  transcriptPath: string | undefined
): string | undefined {
  if (!transcriptPath) {
    return undefined
  }
  return readLastTextFromTranscriptOnce(transcriptPath, (line) => {
    try {
      const parsed = parseAgentHookJson(line)
      if (!isRecord(parsed) || parsed.type !== 'PLANNER_RESPONSE') {
        return undefined
      }
      return normalizeAntigravityModel(parsed.model)
    } catch {
      return undefined
    }
  })
}

function readBoundedJsonRecord(
  filePath: string,
  cache: AntigravityBrainCache
): { record: Record<string, unknown>; mtimeMs: number } | undefined {
  try {
    const { buffer, stats } = readNodeFileSyncWithinLimit(filePath, BRAIN_METADATA_MAX_BYTES, {
      regularFileOnly: true
    })
    const cached = cache.jsonFiles.get(filePath)
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return cached.parsed ? { record: cached.parsed, mtimeMs: stats.mtimeMs } : undefined
    }
    const parsed = parseAgentHookJson(buffer.toString('utf8'))
    const record = isRecord(parsed) ? parsed : null
    if (cache.jsonFiles.size >= BRAIN_CACHE_MAX_ENTRIES) {
      cache.jsonFiles.clear()
    }
    cache.jsonFiles.set(filePath, { mtimeMs: stats.mtimeMs, size: stats.size, parsed: record })
    return record ? { record, mtimeMs: stats.mtimeMs } : undefined
  } catch {
    return undefined
  }
}

export function readAntigravityBrainSubagents(
  rootBrainDir: string,
  cache: AntigravityBrainCache
): AntigravityDiskSubagent[] {
  const subagentsDir = join(rootBrainDir, '.system_generated', 'subagents')
  const files = readTranscriptDirectory(subagentsDir)
  const result: AntigravityDiskSubagent[] = []
  for (const name of files) {
    if (!name.endsWith('.json')) {
      continue
    }
    const loaded = readBoundedJsonRecord(join(subagentsDir, name), cache)
    if (!loaded) {
      continue
    }
    const conversationId = readFirstString(loaded.record, ['conversationId', 'conversation_id'])
    if (!conversationId) {
      continue
    }
    const descriptor = isRecord(loaded.record.subagentDescriptor)
      ? loaded.record.subagentDescriptor
      : undefined
    result.push({
      conversationId,
      state: typeof loaded.record.state === 'string' ? loaded.record.state : 'SUBAGENT_STATE_ALIVE',
      typeName: descriptor ? readFirstString(descriptor, ['typeName', 'type_name']) : undefined,
      role: descriptor ? readFirstString(descriptor, ['role']) : undefined,
      mtimeMs: loaded.mtimeMs
    })
  }
  return result
}

export function readAntigravitySwarmMembers(
  rootBrainDir: string,
  cache: AntigravityBrainCache
): { title?: string; mtimeMs: number; members: AntigravityDiskSwarmMember[] } | undefined {
  const membersPath = join(rootBrainDir, '.system_generated', 'swarm', 'members.json')
  const loaded = readBoundedJsonRecord(membersPath, cache)
  if (!loaded || !isRecord(loaded.record.members)) {
    return undefined
  }
  const members: AntigravityDiskSwarmMember[] = []
  for (const [name, raw] of Object.entries(loaded.record.members)) {
    if (!isRecord(raw)) {
      continue
    }
    const conversationId = readFirstString(raw, ['conversation_id', 'conversationId'])
    if (!conversationId) {
      continue
    }
    members.push({
      name,
      conversationId,
      role: readFirstString(raw, ['role']),
      phase: readFirstString(raw, ['phase']),
      desiredState: readFirstString(raw, ['desired_state', 'desiredState']),
      wakeMode: readFirstString(raw, ['wake_mode', 'wakeMode']),
      killed: raw.killed === true,
      model: normalizeAntigravityModel(raw.applied_model) ?? normalizeAntigravityModel(raw.model)
    })
  }
  return {
    title: readFirstString(loaded.record, ['title']),
    mtimeMs: loaded.mtimeMs,
    members
  }
}

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

export function readAntigravityChildStartedAt(
  rootBrainDir: string,
  childId: string
): number | undefined {
  const path = childTranscriptFilePath(rootBrainDir, childId)
  const first = path ? readFirstTranscriptRecord(path) : undefined
  if (!isRecord(first) || typeof first.created_at !== 'string') {
    return undefined
  }
  const parsed = Date.parse(first.created_at)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function readAntigravityChildTranscriptModel(
  rootBrainDir: string,
  childId: string
): string | undefined {
  const path = childTranscriptFilePath(rootBrainDir, childId)
  return path ? readAntigravityTranscriptModel(path) : undefined
}

export function readAntigravityChildTranscriptTail(
  rootBrainDir: string,
  childId: string
): AntigravityChildTranscriptTail | undefined {
  const childTranscriptPath = childTranscriptFilePath(rootBrainDir, childId)
  if (!childTranscriptPath) {
    return undefined
  }
  let captured: AntigravityChildTranscriptTail | undefined
  readLastTextFromTranscriptOnce(childTranscriptPath, (line) => {
    try {
      const parsed = parseAgentHookJson(line)
      if (!isRecord(parsed)) {
        return undefined
      }
      const toolCalls = Array.isArray(parsed.tool_calls) ? parsed.tool_calls : []
      const firstCall = toolCalls.length > 0 && isRecord(toolCalls[0]) ? toolCalls[0] : undefined
      const toolSnapshot = firstCall
        ? extractAntigravityToolFields('PreToolUse', {
            toolCall: {
              name: readFirstString(firstCall, ['name', 'toolName', 'tool_name']),
              args: unwrapCompactTranscriptArgs(firstCall.args)
            }
          })
        : undefined
      const status = typeof parsed.status === 'string' ? parsed.status : undefined
      const settled =
        parsed.type === 'PLANNER_RESPONSE' &&
        (status === 'DONE' || status === 'ERROR' || status === 'CANCELLED') &&
        toolCalls.length === 0
      const createdAtRaw =
        typeof parsed.created_at === 'string' ? Date.parse(parsed.created_at) : Number.NaN
      captured = {
        settled,
        stepIndex: typeof parsed.step_index === 'number' ? parsed.step_index : undefined,
        model: normalizeAntigravityModel(parsed.model),
        toolName: toolSnapshot?.toolName,
        toolInput: toolSnapshot?.toolInput,
        createdAtMs: Number.isFinite(createdAtRaw) ? createdAtRaw : undefined
      }
      return 'captured'
    } catch {
      return undefined
    }
  })
  return captured
}
