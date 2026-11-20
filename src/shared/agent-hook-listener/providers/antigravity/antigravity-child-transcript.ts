import { dirname, join } from 'node:path'
import { readJsonlCursorBytes, type RolloutReadBatch } from '../codex/codex-rollout-async-reads'
import { applyJsonlCursorBytes } from '../codex/codex-rollout-jsonl-format'
import {
  normalizeAntigravityModel,
  type AntigravityBrainCache,
  type AntigravityChildTranscriptTail
} from './antigravity-brain-metadata'

export function antigravityTranscriptFilePath(
  rootBrainDir: string,
  childId: string
): string | undefined {
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
  const childTranscriptPath = antigravityTranscriptFilePath(rootBrainDir, childId)
  if (!childTranscriptPath) {
    return undefined
  }
  const previous = cache.transcripts.get(childTranscriptPath) ?? {
    cursor: { filePath: childTranscriptPath, offset: 0, carry: '' }
  }
  const read = await readJsonlCursorBytes(previous.cursor, batch)
  if (!batch.wanted()) {
    return undefined
  }
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
    const model = normalizeAntigravityModel(parsed.model)
    if (model) {
      previous.model = model
      // A whole-second stamp may hide a later millisecond, so it reads as that second's end.
      const wholeSecond = typeof parsed.created_at === 'string' && !/\d\.\d/.test(parsed.created_at)
      previous.modelAt = Number.isFinite(createdAt)
        ? createdAt + (wholeSecond ? 999 : 0)
        : undefined
    }
    previous.tail = { model: previous.model, modelAt: previous.modelAt }
  }
  cache.transcripts.set(childTranscriptPath, previous)
  return previous.tail
}
