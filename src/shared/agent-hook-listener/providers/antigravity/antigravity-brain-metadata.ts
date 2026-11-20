import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readPathFromKeys } from '../../../agent-session/lifecycle/agent-session-resume'
import { isRecord } from '../../../agent-status/child-work/agent-status-child-work-value-guards'
import {
  AGENT_MODEL_MAX_LENGTH,
  normalizeOptionalField
} from '../../../agent-status/contracts/agent-status-field-normalization'
import { readNodeFileWithinLimit } from '../../../file-content/node-bounded-file-reader'
import { readFirstString } from '../../interactive-tool'
import { parseAgentHookJson } from '../../request-body'
import type { JsonlCursor } from '../codex/codex-rollout-jsonl-format'

const BRAIN_METADATA_MAX_BYTES = 256 * 1024
const TRANSCRIPT_SUFFIX_RE = /[\\/]\.system_generated[\\/]logs[\\/]transcript(?:_full)?\.jsonl$/
export type AntigravityChildTranscriptTail = { model?: string }
export type AntigravityChildMetadata = {
  description?: string
  agentType?: string
  model?: string
  killed: boolean
}
export type AntigravityBrainCache = {
  jsonFiles: Map<string, { mtimeMs: number; size: number; parsed: Record<string, unknown> | null }>
  transcripts: Map<
    string,
    {
      cursor: JsonlCursor
      tail?: AntigravityChildTranscriptTail
      model?: string
      startedAt?: number
    }
  >
  swarm?: { record: Record<string, unknown>; members: Map<string, AntigravityChildMetadata> }
}
export function createAntigravityBrainCache(): AntigravityBrainCache {
  return { jsonFiles: new Map(), transcripts: new Map() }
}
export function resolveAntigravityBrainDirectory(
  hookPayload: Record<string, unknown>,
  transcriptPath: string | undefined
): string | undefined {
  // Child descriptors and transcripts are addressed relative to <brain>/<conversationId>, which the
  // transcript path pins; the artifact directory is only a fallback when no transcript is reported.
  if (transcriptPath && TRANSCRIPT_SUFFIX_RE.test(transcriptPath)) {
    return transcriptPath.replace(TRANSCRIPT_SUFFIX_RE, '') || undefined
  }
  return readPathFromKeys(hookPayload, ['artifactDirectoryPath', 'artifact_directory_path'])
}
export function normalizeAntigravityModel(raw: unknown): string | undefined {
  const normalized = normalizeOptionalField(raw, AGENT_MODEL_MAX_LENGTH)
  return normalized && normalized.toLowerCase() !== 'auto' ? normalized : undefined
}
async function readBoundedJsonRecord(
  filePath: string,
  cache: AntigravityBrainCache,
  wanted: () => boolean = () => true
): Promise<Record<string, unknown> | undefined> {
  try {
    const cached = cache.jsonFiles.get(filePath)
    const stats = await stat(filePath)
    if (cached?.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return cached.parsed ?? undefined
    }
    const { buffer, stats: readStats } = await readNodeFileWithinLimit(
      filePath,
      BRAIN_METADATA_MAX_BYTES,
      { regularFileOnly: true }
    )
    if (!wanted()) {
      return undefined
    }
    const parsed = parseAgentHookJson(buffer.toString('utf8'))
    const record = isRecord(parsed) ? parsed : null
    cache.jsonFiles.set(filePath, {
      mtimeMs: readStats.mtimeMs,
      size: readStats.size,
      parsed: record
    })
    return record ?? undefined
  } catch {
    return undefined
  }
}
export function antigravityChildDescriptorPath(brain: string, childId: string): string | undefined {
  if (!childId || childId.includes('/') || childId.includes('\\') || childId.includes('..')) {
    return undefined
  }
  return join(brain, '.system_generated', 'subagents', `${childId}.json`)
}
export async function readAntigravityChildMetadata(
  brain: string,
  childId: string,
  cache: AntigravityBrainCache,
  wanted: () => boolean = () => true
): Promise<AntigravityChildMetadata | undefined> {
  const path = antigravityChildDescriptorPath(brain, childId)
  if (!path) {
    return undefined
  }
  const record = await readBoundedJsonRecord(path, cache, wanted)
  if (!record || (record.conversationId !== undefined && record.conversationId !== childId)) {
    return undefined
  }
  const descriptor = isRecord(record.subagentDescriptor) ? record.subagentDescriptor : undefined
  return {
    description: descriptor
      ? readFirstString(descriptor, ['role', 'typeName', 'type_name'])
      : undefined,
    agentType: descriptor ? readFirstString(descriptor, ['typeName', 'type_name']) : undefined,
    killed: record.state === 'SUBAGENT_STATE_KILLED'
  }
}
export async function readAntigravitySwarmMembers(
  brain: string,
  cache: AntigravityBrainCache
): Promise<ReadonlyMap<string, AntigravityChildMetadata> | undefined> {
  const record = await readBoundedJsonRecord(
    join(brain, '.system_generated', 'swarm', 'members.json'),
    cache
  )
  if (!record || !isRecord(record.members)) {
    return undefined
  }
  if (cache.swarm?.record === record) {
    return cache.swarm.members
  }
  const members = new Map<string, AntigravityChildMetadata>()
  for (const [name, raw] of Object.entries(record.members)) {
    if (!isRecord(raw)) {
      continue
    }
    const id = readFirstString(raw, ['conversation_id', 'conversationId'])
    if (!id || raw.role === 'coordinator') {
      continue
    }
    members.set(id, {
      description: name,
      agentType: 'Swarm Worker',
      model: normalizeAntigravityModel(raw.applied_model) ?? normalizeAntigravityModel(raw.model),
      // Matches agy's own swarm view: a missing or transitional phase is still a live worker.
      killed:
        raw.killed === true ||
        (raw.desired_state ?? raw.desiredState) === 'KILLED' ||
        raw.phase === 'KILLED'
    })
  }
  cache.swarm = { record, members }
  return members
}
