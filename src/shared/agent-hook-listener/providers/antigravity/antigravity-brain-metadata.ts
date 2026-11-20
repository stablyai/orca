import { readdir, stat } from 'node:fs/promises'
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
import type { RolloutReadBatch } from '../codex/codex-rollout-async-reads'
import type { JsonlCursor } from '../codex/codex-rollout-jsonl-format'

const BRAIN_METADATA_MAX_BYTES = 256 * 1024
const TRANSCRIPT_SUFFIX_RE = /[\\/]\.system_generated[\\/]logs[\\/]transcript(?:_full)?\.jsonl$/

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
  subagentFiles?: {
    mtimeMs: number
    files: Set<string>
    active: Map<string, AntigravityDiskSubagent | undefined>
  }
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
}

export function createAntigravityBrainCache(): AntigravityBrainCache {
  return { jsonFiles: new Map(), transcripts: new Map() }
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

export function normalizeAntigravityModel(raw: unknown): string | undefined {
  const normalized = normalizeOptionalField(raw, AGENT_MODEL_MAX_LENGTH)
  if (!normalized || normalized.toLowerCase() === 'auto') {
    return undefined
  }
  return normalized
}

async function readBoundedJsonRecord(
  filePath: string,
  cache: AntigravityBrainCache
): Promise<{ record: Record<string, unknown>; mtimeMs: number } | undefined> {
  try {
    const cached = cache.jsonFiles.get(filePath)
    const stats = await stat(filePath)
    if (cached?.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return cached.parsed ? { record: cached.parsed, mtimeMs: stats.mtimeMs } : undefined
    }
    const { buffer, stats: readStats } = await readNodeFileWithinLimit(
      filePath,
      BRAIN_METADATA_MAX_BYTES,
      { regularFileOnly: true }
    )
    const parsed = parseAgentHookJson(buffer.toString('utf8'))
    const record = isRecord(parsed) ? parsed : null
    {
      cache.jsonFiles.set(filePath, {
        mtimeMs: readStats.mtimeMs,
        size: readStats.size,
        parsed: record
      })
    }
    return record ? { record, mtimeMs: readStats.mtimeMs } : undefined
  } catch {
    return undefined
  }
}

export async function readAntigravityBrainSubagents(
  rootBrainDir: string,
  cache: AntigravityBrainCache,
  batch: RolloutReadBatch,
  retired: ReadonlySet<string>
): Promise<AntigravityDiskSubagent[]> {
  const subagentsDir = join(rootBrainDir, '.system_generated', 'subagents')
  let directory = cache.subagentFiles
  try {
    const info = await stat(subagentsDir)
    if (!directory || directory.mtimeMs !== info.mtimeMs) {
      const files = new Set((await readdir(subagentsDir)).filter((name) => name.endsWith('.json')))
      const active = directory?.active ?? new Map<string, AntigravityDiskSubagent | undefined>()
      for (const name of files) {
        if (!directory?.files.has(name)) {
          active.set(name, undefined)
        }
      }
      for (const name of active.keys()) {
        if (!files.has(name)) {
          active.delete(name)
          cache.jsonFiles.delete(join(subagentsDir, name))
        }
      }
      directory = { mtimeMs: info.mtimeMs, files, active }
      cache.subagentFiles = directory
    }
  } catch {
    return []
  }
  const result: AntigravityDiskSubagent[] = []
  for (const [name, cachedEntry] of directory.active) {
    if (cachedEntry && retired.has(cachedEntry.conversationId)) {
      directory.active.delete(name)
      cache.jsonFiles.delete(join(subagentsDir, name))
      continue
    }
    if (!batch.wanted()) {
      break
    }
    if (!name.endsWith('.json')) {
      continue
    }
    const loaded = await readBoundedJsonRecord(join(subagentsDir, name), cache)
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
    const entry: AntigravityDiskSubagent = {
      conversationId,
      state: typeof loaded.record.state === 'string' ? loaded.record.state : 'SUBAGENT_STATE_ALIVE',
      typeName: descriptor ? readFirstString(descriptor, ['typeName', 'type_name']) : undefined,
      role: descriptor ? readFirstString(descriptor, ['role']) : undefined,
      mtimeMs: loaded.mtimeMs
    }
    if (entry.state === 'SUBAGENT_STATE_KILLED' || retired.has(conversationId)) {
      directory.active.delete(name)
      cache.jsonFiles.delete(join(subagentsDir, name))
    } else {
      directory.active.set(name, entry)
    }
    result.push(entry)
  }
  return result
}

export async function readAntigravitySwarmMembers(
  rootBrainDir: string,
  cache: AntigravityBrainCache
): Promise<{ title?: string; mtimeMs: number; members: AntigravityDiskSwarmMember[] } | undefined> {
  const membersPath = join(rootBrainDir, '.system_generated', 'swarm', 'members.json')
  const loaded = await readBoundedJsonRecord(membersPath, cache)
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
