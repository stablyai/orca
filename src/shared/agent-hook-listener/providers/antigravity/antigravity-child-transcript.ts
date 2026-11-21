import { dirname, join } from 'node:path'
import { readJsonlCursorBytes, type RolloutReadBatch } from '../codex/codex-rollout-async-reads'
import { applyJsonlCursorBytes } from '../codex/codex-rollout-jsonl-format'
import {
  readAntigravityLaunchResult,
  type AntigravityLaunchResult
} from './antigravity-launch-results'
import {
  normalizeAntigravityModel,
  type AntigravityBrainCache,
  type AntigravityChildTranscriptTail
} from './antigravity-brain-metadata'

const MAX_RECENT_LAUNCH_RESULTS = 256

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
  batch: RolloutReadBatch,
  rootTranscriptPath?: string
): Promise<
  | (AntigravityChildTranscriptTail & {
      launchResults?: ReadonlyMap<number, AntigravityLaunchResult | null>
    })
  | undefined
> {
  const childTranscriptPath =
    rootTranscriptPath ?? antigravityTranscriptFilePath(rootBrainDir, childId)
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
    return { ...previous.tail, launchResults: previous.launchResults }
  }
  const records = applyJsonlCursorBytes(previous.cursor, read)
  if (records === 'stale') {
    return undefined
  }
  if (read && read.from < read.offset) {
    previous.launchResults?.clear()
    previous.model = undefined
    previous.modelAt = undefined
    previous.modelStep = undefined
    previous.tail = undefined
  }
  if (!records) {
    return undefined
  }
  for (const parsed of records) {
    const createdAt =
      typeof parsed.created_at === 'string' ? Date.parse(parsed.created_at) : Number.NaN
    const result = rootTranscriptPath && readAntigravityLaunchResult(parsed)
    if (result && typeof parsed.step_index === 'number') {
      const results = (previous.launchResults ??= new Map())
      const earlier = results.get(parsed.step_index)
      if (earlier === undefined) {
        results.set(parsed.step_index, result)
      } else if (
        earlier &&
        (earlier.tool !== result.tool ||
          earlier.children.length !== result.children.length ||
          earlier.children.some((id, i) => id !== result.children[i]))
      ) {
        results.set(parsed.step_index, null)
      }
      if (results.size > MAX_RECENT_LAUNCH_RESULTS) {
        const oldest = results.keys().next()
        if (!oldest.done) {
          results.delete(oldest.value)
        }
      }
    }
    const model = normalizeAntigravityModel(parsed.model)
    if (model) {
      previous.model = model
      previous.modelAt = Number.isFinite(createdAt) ? createdAt : undefined
      previous.modelStep = typeof parsed.step_index === 'number' ? parsed.step_index : undefined
    }
    previous.tail = {
      model: previous.model,
      modelAt: previous.modelAt,
      modelStep: previous.modelStep
    }
  }
  cache.transcripts.set(childTranscriptPath, previous)
  return { ...previous.tail, launchResults: previous.launchResults }
}
