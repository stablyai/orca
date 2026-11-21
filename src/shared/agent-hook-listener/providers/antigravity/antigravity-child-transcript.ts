import { dirname, join } from 'node:path'
import { readJsonlCursorBytes, type RolloutReadBatch } from '../codex/codex-rollout-async-reads'
import { applyJsonlCursorBytes, type JsonRecord } from '../codex/codex-rollout-jsonl-format'
import {
  readAntigravityLaunchResult,
  type AntigravityLaunchResult
} from './antigravity-launch-results'
import {
  normalizeAntigravityModel,
  type AntigravityBrainCache,
  type AntigravityChildTranscriptTail
} from './antigravity-brain-metadata'
import type { AntigravityPaneChildState } from './antigravity-pane-state'

const MAX_RECENT_LAUNCH_RESULTS = 256

type LaunchResults = Map<number, AntigravityLaunchResult | null>
type RootTranscript = {
  path: string
  pendingSteps: ReadonlyMap<number | undefined, unknown>
  readsModel: boolean
}
export type AntigravityLeadModelFence = Pick<
  AntigravityPaneChildState,
  'leadModel' | 'leadModelSince' | 'leadModelFromStep'
>

export function applyAntigravityLeadModel(
  pane: AntigravityPaneChildState,
  tail: AntigravityChildTranscriptTail | undefined,
  fence: AntigravityLeadModelFence | undefined
): void {
  // A hook that set the lead model during the read wins over the older transcript line.
  if (
    !tail?.model ||
    !fence ||
    fence.leadModel !== pane.leadModel ||
    fence.leadModelSince !== pane.leadModelSince ||
    fence.leadModelFromStep !== pane.leadModelFromStep
  ) {
    return
  }
  const fromStep = pane.leadModelFromStep
  // Step indices order turns exactly even when agy's whole-second timestamps overlap.
  const current =
    pane.leadModelSince === undefined ||
    (fromStep !== undefined && tail.modelStep !== undefined
      ? tail.modelStep >= fromStep
      : (tail.modelAt ?? Number.NEGATIVE_INFINITY) >= pane.leadModelSince)
  if (current) {
    pane.leadModel = tail.model
    pane.leadModelSince = undefined
    pane.leadModelFromStep = undefined
  }
}

function pendingResults(root: RootTranscript | undefined, recent: LaunchResults | undefined) {
  if (!root?.pendingSteps.size) {
    return undefined
  }
  const results: LaunchResults = new Map()
  if (recent) {
    for (const step of root.pendingSteps.keys()) {
      const result = step === undefined ? undefined : recent.get(step)
      if (step !== undefined && result !== undefined) {
        results.set(step, result)
      }
    }
  }
  return results
}

function transcriptModel(record: JsonRecord): AntigravityChildTranscriptTail | undefined {
  const model = normalizeAntigravityModel(record.model)
  if (!model) {
    return undefined
  }
  const createdAt =
    typeof record.created_at === 'string' ? Date.parse(record.created_at) : Number.NaN
  return {
    model,
    modelAt: Number.isFinite(createdAt) ? createdAt : undefined,
    modelStep: typeof record.step_index === 'number' ? record.step_index : undefined
  }
}

async function readLatestModel(filePath: string, batch: RolloutReadBatch) {
  const cursor = { filePath, offset: 0, carry: '' }
  const read = await readJsonlCursorBytes(cursor, batch)
  if (read === 'deferred' || !batch.wanted()) {
    return undefined
  }
  const records = applyJsonlCursorBytes(cursor, read)
  if (records && records !== 'stale') {
    for (let index = records.length - 1; index >= 0; index--) {
      const model = transcriptModel(records[index]!)
      if (model) {
        return model
      }
    }
  }
  return undefined
}

function mergeLaunchResult(
  earlier: AntigravityLaunchResult | null | undefined,
  result: AntigravityLaunchResult
): AntigravityLaunchResult | null {
  if (earlier === undefined) {
    return result
  }
  return earlier &&
    earlier.tool === result.tool &&
    earlier.children.length === result.children.length &&
    earlier.children.every((id, i) => id === result.children[i])
    ? earlier
    : null
}

export function antigravityTranscriptFilePath(
  rootBrainDir: string,
  childId: string
): string | undefined {
  if (!childId || childId.includes('/') || childId.includes('\\') || childId.includes('..')) {
    return undefined
  }
  return join(dirname(rootBrainDir), childId, '.system_generated', 'logs', 'transcript.jsonl')
}

export function antigravityRootTranscriptPath(pane: AntigravityPaneChildState): string | undefined {
  if (pane.rootConversationId && pane.rootBrainDir) {
    return (
      pane.rootTranscriptPath ??
      antigravityTranscriptFilePath(pane.rootBrainDir, pane.rootConversationId)
    )
  }
  return undefined
}

export async function readAntigravityChildTranscriptTail(
  rootBrainDir: string,
  childId: string,
  cache: AntigravityBrainCache,
  batch: RolloutReadBatch,
  root?: RootTranscript
): Promise<
  | (AntigravityChildTranscriptTail & {
      launchResults?: ReadonlyMap<number, AntigravityLaunchResult | null>
      hasMore?: true
    })
  | undefined
> {
  const childTranscriptPath = root?.path ?? antigravityTranscriptFilePath(rootBrainDir, childId)
  if (!childTranscriptPath) {
    return undefined
  }
  const previous = cache.transcripts.get(childTranscriptPath) ?? {
    cursor: { filePath: childTranscriptPath, offset: 0, carry: '' }
  }
  const read = await readJsonlCursorBytes(previous.cursor, batch, root ? 'forward' : 'tail')
  // A long launch backlog should not delay a model already visible at the end of the transcript.
  const latestModel =
    read !== 'deferred' && read?.hasMore && root?.readsModel && batch.wanted()
      ? await readLatestModel(root.path, batch)
      : undefined
  if (!batch.wanted()) {
    return undefined
  }
  if (read === 'deferred') {
    return {
      ...(root ? undefined : previous.tail),
      launchResults: pendingResults(root, previous.launchResults)
    }
  }
  const records = applyJsonlCursorBytes(previous.cursor, read)
  if (records === 'stale') {
    return undefined
  }
  if (read && read.from < read.offset) {
    previous.launchResults?.clear()
    previous.tail = undefined
  }
  if (!records) {
    return undefined
  }
  const matches = pendingResults(root, previous.launchResults)
  for (const parsed of records) {
    const result = root && readAntigravityLaunchResult(parsed)
    const step = parsed.step_index
    if (result && typeof step === 'number') {
      const results = (previous.launchResults ??= new Map())
      const matched = matches?.get(step)
      const merged = mergeLaunchResult(matched === undefined ? results.get(step) : matched, result)
      results.set(step, merged)
      if (matches && root?.pendingSteps.has(step)) {
        matches.set(step, merged)
      }
      if (results.size > MAX_RECENT_LAUNCH_RESULTS) {
        const oldest = results.keys().next()
        if (!oldest.done) {
          results.delete(oldest.value)
        }
      }
    }
    previous.tail = transcriptModel(parsed) ?? previous.tail
  }
  cache.transcripts.set(childTranscriptPath, previous)
  return {
    ...(read?.hasMore ? latestModel : previous.tail),
    launchResults: matches,
    hasMore: read?.hasMore
  }
}
