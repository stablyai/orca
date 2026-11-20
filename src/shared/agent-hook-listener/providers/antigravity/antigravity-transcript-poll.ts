import { join } from 'node:path'
import type { AgentHookEventPayload } from '../../listener-event'
import type { HookListenerState } from '../../listener-state'
import { RolloutReadBatch } from '../codex/codex-rollout-async-reads'
import { buildAntigravityFoldedStatusPayload } from './antigravity-parent-status'
import {
  readAntigravityChildMetadata,
  readAntigravitySwarmMembers,
  type AntigravityChildMetadata
} from './antigravity-brain-metadata'
import { readAntigravityChildTranscriptTail } from './antigravity-child-transcript'
import {
  retireAntigravityChild,
  type AntigravityPaneChildState,
  type TrackedAntigravityChild
} from './antigravity-pane-state'

export function hasAntigravityPollWork(
  state: HookListenerState,
  event: AgentHookEventPayload
): boolean {
  const pane = state.antigravityChildWorkByPaneKey.get(event.paneKey)
  return Boolean(
    pane &&
    (pane.dirty ||
      (pane.rootBrainDir &&
        (pane.children.size > 0 || (pane.leadModel === undefined && pane.leadState === 'working'))))
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
}
export async function readAntigravityTranscriptPoll(
  state: HookListenerState,
  paneKey: string
): Promise<AntigravityTranscriptPollReads | undefined> {
  const pane = state.antigravityChildWorkByPaneKey.get(paneKey)
  if (!pane) {
    return undefined
  }
  const cache = pane.brainCache
  const wanted = (): boolean =>
    state.antigravityChildWorkByPaneKey.get(paneKey) === pane && pane.brainCache === cache
  const result: AntigravityTranscriptPollReads = { pane, cache, children: [] }
  const brain = pane.rootBrainDir
  if (!brain) {
    return result
  }
  const candidates = [...pane.children.values()].map((child) => ({
    child,
    revision: child.revision
  }))
  const members = candidates.length ? await readAntigravitySwarmMembers(brain, cache) : undefined
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
        child.model === undefined && metadata && !metadata.killed
          ? (await readAntigravityChildTranscriptTail(brain, child.id, cache, batch))?.model
          : undefined
      if (current()) {
        result.children.push({ child, revision, metadata, model })
      }
      if (model) {
        cache.transcripts.delete(
          join(brain, '..', child.id, '.system_generated', 'logs', 'transcript.jsonl')
        )
      }
    } finally {
      batch.release()
    }
  }
  if (pane.leadModel === undefined && pane.rootConversationId && wanted()) {
    const batch = new RolloutReadBatch(wanted)
    try {
      result.leadModel = (
        await readAntigravityChildTranscriptTail(brain, pane.rootConversationId, cache, batch)
      )?.model
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
  pane.leadModel ??= reads.leadModel
  for (const { child, revision, metadata, model } of reads.children) {
    if (pane.children.get(child.id) !== child || child.revision !== revision) {
      continue
    }
    if (metadata?.killed) {
      retireAntigravityChild(pane, child.id)
    } else if (metadata) {
      pane.verifiedChildren.add(child.id)
      pane.helpersIdleAt = undefined
      pane.awaitingInitialHelperDiscovery = undefined
      child.description = metadata.description
      child.agentType = metadata.agentType
      child.model = metadata.model ?? child.model ?? model
    }
  }
  pane.dirty = false
  const payload = buildAntigravityFoldedStatusPayload(state, original.paneKey, pane, Date.now())
  return payload ? { ...original, hookEventName: undefined, payload } : undefined
}
