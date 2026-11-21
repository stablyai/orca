import type { AgentHookEventPayload } from '../../listener-event'
import type { HookListenerState } from '../../listener-state'
import { readJsonlCursorBytes, RolloutReadBatch } from '../codex/codex-rollout-async-reads'
import {
  applyJsonlCursorBytes,
  sameJsonlFingerprint,
  type JsonRecord
} from '../codex/codex-rollout-jsonl-format'
import {
  antigravityModelPollOwner,
  antigravityModelReadEndsAt,
  normalizeAntigravityModel,
  type AntigravityLeadModelFence,
  type AntigravityRootModel,
  type AntigravityTranscriptModel
} from './antigravity-root-model'

export type AntigravityTranscriptPollReads = {
  root: AntigravityRootModel
  fence: AntigravityLeadModelFence
  model?: AntigravityTranscriptModel
  nextPoll?: 'backlog'
}

function latestTranscriptModel(records: JsonRecord[]): AntigravityTranscriptModel | undefined {
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index]!
    const model = normalizeAntigravityModel(record.model)
    if (model) {
      return {
        model,
        at: typeof record.created_at === 'string' ? Date.parse(record.created_at) : Number.NaN,
        step: typeof record.step_index === 'number' ? record.step_index : undefined
      }
    }
  }
  return undefined
}

export async function readAntigravityTranscriptPoll(
  state: HookListenerState,
  paneKey: string,
  live: () => boolean,
  signal?: AbortSignal
): Promise<AntigravityTranscriptPollReads | undefined> {
  const row = state.lastStatusByPaneKey.get(paneKey)
  const root = row && antigravityModelPollOwner(state, row)
  const fence = root?.fence
  if (!root || !fence) {
    return undefined
  }
  const wanted = (): boolean =>
    live() &&
    state.antigravityChildWorkByPaneKey.get(paneKey)?.rootModel === root &&
    root.fence === fence &&
    Date.now() < antigravityModelReadEndsAt(root)
  const batch = new RolloutReadBatch(wanted, signal)
  try {
    const read = await readJsonlCursorBytes(root.cursor, batch, 'forward', {
      previous: root.fingerprint
    })
    if (!wanted() || !read || read === 'deferred' || !read.fingerprint) {
      return undefined
    }
    const records = applyJsonlCursorBytes(root.cursor, read)
    if (records === 'stale') {
      return undefined
    }
    if (read.from < read.offset) {
      root.transcriptModel = undefined
    }
    root.fingerprint = read.fingerprint
    if (!records) {
      return undefined
    }
    root.transcriptModel = latestTranscriptModel(records) ?? root.transcriptModel
    if (read.hasMore) {
      const fingerprint = read.fingerprint
      let preview = root.tailPreview
      if (!preview || !sameJsonlFingerprint(preview.fingerprint, fingerprint)) {
        root.tailPreview = undefined
        // A model near the end can be shown before the forward cursor catches up.
        const tail = { filePath: root.cursor.filePath, offset: 0, carry: '' }
        const bytes = await readJsonlCursorBytes(tail, batch, 'tail', {})
        if (!wanted()) {
          return undefined
        }
        const tailRecords =
          bytes &&
          bytes !== 'deferred' &&
          bytes.fingerprint &&
          sameJsonlFingerprint(fingerprint, bytes.fingerprint) &&
          applyJsonlCursorBytes(tail, bytes)
        preview =
          tailRecords && tailRecords !== 'stale'
            ? { fingerprint, model: latestTranscriptModel(tailRecords) }
            : undefined
        root.tailPreview = preview
      }
      return { root, fence, model: preview?.model, nextPoll: 'backlog' }
    }
    root.tailPreview = undefined
    return { root, fence, model: root.transcriptModel }
  } finally {
    batch.release()
  }
}

export function pollAntigravityTranscriptStatus(
  state: HookListenerState,
  original: AgentHookEventPayload,
  reads: AntigravityTranscriptPollReads | undefined
): AgentHookEventPayload {
  const root = antigravityModelPollOwner(state, original)
  if (!reads || !root || root !== reads.root || root.fence !== reads.fence || !reads.model) {
    return original
  }
  const { fence, model } = reads
  // agy timestamps are whole seconds, so step indices take precedence at the turn boundary.
  const current =
    fence.fromStep !== undefined && model.step !== undefined
      ? model.step >= fence.fromStep
      : model.at >= fence.since
  if (!current) {
    return original
  }
  root.leadModel = model.model
  root.fence = undefined
  return { ...original, payload: { ...original.payload, model: model.model } }
}
