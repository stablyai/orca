import type { AgentHookEventPayload } from '../../listener-event'
import type { HookListenerState } from '../../listener-state'
import { RolloutReadBatch } from '../codex/codex-rollout-async-reads'
import { buildAntigravityFoldedStatusPayload } from './antigravity-parent-status'
import {
  readAntigravityChildMetadata,
  readAntigravitySwarmMembers,
  type AntigravityChildMetadata
} from './antigravity-brain-metadata'
import {
  antigravityTranscriptFilePath,
  readAntigravityChildTranscriptTail
} from './antigravity-child-transcript'
import {
  verifyAntigravityChild,
  retireAntigravityChild,
  type AntigravityPaneChildState,
  type TrackedAntigravityChild
} from './antigravity-pane-state'

function readsLeadModel(pane: AntigravityPaneChildState): boolean {
  return pane.leadModel === undefined || pane.leadModelSince !== undefined
}
export function hasAntigravityPollWork(
  state: HookListenerState,
  event: AgentHookEventPayload
): boolean {
  const pane = state.antigravityChildWorkByPaneKey.get(event.paneKey)
  return Boolean(
    pane &&
    (pane.dirty ||
      (pane.rootBrainDir &&
        (pane.children.size > 0 ||
          (readsLeadModel(pane) && pane.leadState === 'working' && pane.rootConversationId))))
  )
}
export type AntigravityTranscriptPollReads = {
  pane: AntigravityPaneChildState
  cache: AntigravityPaneChildState['brainCache']
  children: {
    child: TrackedAntigravityChild
    revision: number
    metadata?: AntigravityChildMetadata
    model?: string
  }[]
  leadModel?: string
  leadModelAt?: number
  leadModelFence?: Pick<AntigravityPaneChildState, 'leadModel' | 'leadModelSince'>
}
export async function readAntigravityTranscriptPoll(
  state: HookListenerState,
  paneKey: string,
  live: () => boolean = () => true
): Promise<AntigravityTranscriptPollReads | undefined> {
  const pane = state.antigravityChildWorkByPaneKey.get(paneKey)
  if (!pane) {
    return undefined
  }
  const cache = pane.brainCache
  const wanted = (): boolean =>
    live() && state.antigravityChildWorkByPaneKey.get(paneKey) === pane && pane.brainCache === cache
  const result: AntigravityTranscriptPollReads = { pane, cache, children: [] }
  const brain = pane.rootBrainDir
  if (!brain) {
    return result
  }
  const candidates = [...pane.children.values()].map((child) => ({
    child,
    revision: child.revision
  }))
  const members = candidates.length
    ? await readAntigravitySwarmMembers(brain, cache, wanted)
    : undefined
  for (const { child, revision } of candidates) {
    const current = (): boolean =>
      wanted() && pane.children.get(child.id) === child && child.revision === revision
    if (!wanted()) {
      return undefined
    }
    if (!current()) {
      continue
    }
    const metadata =
      members?.get(child.id) ??
      (await readAntigravityChildMetadata(brain, child.id, cache, current))
    if (!current()) {
      continue
    }
    const batch = new RolloutReadBatch(current)
    try {
      const model =
        (child.model === undefined || child.modelAuto) &&
        metadata &&
        !metadata.model &&
        !metadata.killed &&
        !child.stopped
          ? (await readAntigravityChildTranscriptTail(brain, child.id, cache, batch))?.model
          : undefined
      if (current()) {
        result.children.push({ child, revision, metadata, model })
      }
      const transcript = antigravityTranscriptFilePath(brain, child.id)
      // An automatic model can change mid-run, so its transcript keeps its read position.
      if (model && !child.modelAuto && transcript) {
        cache.transcripts.delete(transcript)
      }
    } finally {
      batch.release()
    }
  }
  if (readsLeadModel(pane) && pane.leadState === 'working' && pane.rootConversationId && wanted()) {
    const fence = { leadModel: pane.leadModel, leadModelSince: pane.leadModelSince }
    const batch = new RolloutReadBatch(wanted)
    try {
      const tail = await readAntigravityChildTranscriptTail(
        brain,
        pane.rootConversationId,
        cache,
        batch
      )
      result.leadModel = tail?.model
      result.leadModelAt = tail?.modelAt
      result.leadModelFence = fence
    } finally {
      batch.release()
    }
  }
  return wanted() ? result : undefined
}
export function pollAntigravityTranscriptStatus(
  state: HookListenerState,
  original: AgentHookEventPayload,
  reads: AntigravityTranscriptPollReads | undefined
): AgentHookEventPayload | undefined {
  const pane = state.antigravityChildWorkByPaneKey.get(original.paneKey)
  if (!reads || pane !== reads.pane || pane.brainCache !== reads.cache) {
    return undefined
  }
  // A hook that set the lead model while this read ran wins over the older transcript line.
  const fence = reads.leadModelFence
  if (
    reads.leadModel &&
    fence &&
    fence.leadModel === pane.leadModel &&
    fence.leadModelSince === pane.leadModelSince
  ) {
    // An automatic turn takes only a model recorded after it started; until then the last one stays.
    const current =
      pane.leadModelSince === undefined ||
      (reads.leadModelAt ?? Number.NEGATIVE_INFINITY) >= pane.leadModelSince
    if (current || pane.leadModel === undefined) {
      pane.leadModel = reads.leadModel
    }
    if (current) {
      pane.leadModelSince = undefined
    }
  }
  const proven: string[] = []
  for (const { child, revision, metadata, model } of reads.children) {
    if (pane.children.get(child.id) !== child || child.revision !== revision) {
      continue
    }
    if (metadata?.killed && pane.verifiedChildren.has(child.id)) {
      retireAntigravityChild(pane, child.id)
    } else if (metadata) {
      verifyAntigravityChild(pane, child.id)
      child.description = metadata.description
      child.agentType = metadata.agentType
      child.model =
        metadata.model ?? (child.modelAuto ? (model ?? child.model) : (child.model ?? model))
      // A killed descriptor still proves ownership; list the child once so its end is visible.
      if (child.stopped || metadata.killed) {
        proven.push(child.id)
      }
    } else if (child.stopped && pane.pendingHelperSpawns === undefined) {
      // While a spawn is pending a failed read retries next poll instead of losing its proof.
      retireAntigravityChild(pane, child.id)
    }
  }
  pane.dirty = false
  const payload = buildAntigravityFoldedStatusPayload(state, original.paneKey, pane, Date.now())
  // Publish a child proven after it stopped once, so relayed receivers also see it end.
  for (const id of proven) {
    retireAntigravityChild(pane, id)
  }
  return payload ? { ...original, hookEventName: undefined, payload } : undefined
}
