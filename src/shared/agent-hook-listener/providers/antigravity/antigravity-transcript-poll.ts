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
import { decodeAntigravityStepIndex } from './antigravity-step-index'

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
        step: decodeAntigravityStepIndex(record.step_index)
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
  const batch = new RolloutReadBatch(wanted, signal, () => antigravityModelReadEndsAt(root))
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
    if (read.reset || read.from < read.offset) {
      root.transcriptModel = undefined
      root.tailPreview = undefined
    }
    root.fingerprint = read.fingerprint
    if (!records) {
      return undefined
    }
    root.transcriptModel = latestTranscriptModel(records) ?? root.transcriptModel
    if (read.hasMore) {
      const fingerprint = read.fingerprint
      const preview = (root.tailPreview ??= {
        cursor: { filePath: root.cursor.filePath, offset: 0, carry: '' }
      })
      if (!preview.fingerprint || !sameJsonlFingerprint(preview.fingerprint, fingerprint)) {
        // Preview the tail once, then follow appends while the historical cursor catches up.
        const bytes = await readJsonlCursorBytes(preview.cursor, batch, 'tail', {
          previous: preview.fingerprint,
          expected: fingerprint
        })
        if (!wanted()) {
          return undefined
        }
        if (!bytes || bytes === 'deferred' || !bytes.fingerprint) {
          return { root, fence, nextPoll: 'backlog' }
        }
        const tailRecords = applyJsonlCursorBytes(preview.cursor, bytes)
        if (!tailRecords || tailRecords === 'stale' || bytes.hasMore) {
          // A short or failed read must not publish a partial preview or cache it as complete.
          root.tailPreview = undefined
          return { root, fence, nextPoll: 'backlog' }
        }
        if (bytes.reset || bytes.start !== bytes.from) {
          preview.model = undefined
        }
        preview.model = latestTranscriptModel(tailRecords) ?? preview.model
        preview.fingerprint = bytes.fingerprint
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
