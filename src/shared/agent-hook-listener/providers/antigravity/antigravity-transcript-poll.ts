import type { AgentHookEventPayload } from '../../listener-event'
import type { HookListenerState } from '../../listener-state'
import { RolloutReadBatch } from '../codex/codex-rollout-async-reads'
import { buildAntigravityFoldedStatusPayload } from './antigravity-parent-status'
import {
  readAntigravityBrainSubagents,
  readAntigravitySwarmMembers
} from './antigravity-brain-metadata'
import { readAntigravityChildTranscriptTail } from './antigravity-child-transcript'
import type { AntigravityPaneChildState } from './antigravity-pane-state'

export function hasAntigravityPollWork(
  state: HookListenerState,
  event: AgentHookEventPayload
): boolean {
  const pane = state.antigravityChildWorkByPaneKey.get(event.paneKey)
  return Boolean(
    pane?.rootBrainDir &&
    (pane.discoversChildren ||
      pane.awaitingInitialHelperDiscovery ||
      event.payload.subagents?.length ||
      (pane.leadModel === undefined && pane.leadState === 'working')) &&
    event.payload.state !== 'done'
  )
}

export type AntigravityTranscriptPollReads = {
  pane: AntigravityPaneChildState
  diskSubagents: NonNullable<AntigravityPaneChildState['diskSubagents']>
  swarmMembers: NonNullable<AntigravityPaneChildState['swarmMembers']>
  tails: AntigravityPaneChildState['transcriptTails']
  leadModel?: string
}

export async function readAntigravityTranscriptPoll(
  state: HookListenerState,
  paneKey: string
): Promise<AntigravityTranscriptPollReads | undefined> {
  const pane = state.antigravityChildWorkByPaneKey.get(paneKey)
  if (!pane?.rootBrainDir) {
    return undefined
  }
  const cache = pane.brainCache
  const batch = new RolloutReadBatch(
    () => state.antigravityChildWorkByPaneKey.get(paneKey) === pane && pane.brainCache === cache
  )
  try {
    const leadModel =
      pane.leadModel === undefined && pane.rootConversationId
        ? (
            await readAntigravityChildTranscriptTail(
              pane.rootBrainDir,
              pane.rootConversationId,
              cache,
              batch
            )
          )?.model
        : undefined
    batch.unreserve(Number.MAX_SAFE_INTEGER)
    const diskSubagents = (
      await readAntigravityBrainSubagents(pane.rootBrainDir, cache, batch, pane.retiredChildren)
    ).filter(
      (child) =>
        !pane.retiredBefore ||
        child.mtimeMs > pane.retiredBefore ||
        pane.children.has(child.conversationId)
    )
    const swarm = await readAntigravitySwarmMembers(pane.rootBrainDir, cache)
    const swarmMembers =
      swarm && (!pane.retiredBefore || swarm.mtimeMs > pane.retiredBefore)
        ? swarm.members
        : (pane.swarmMembers ?? [])
    const ids = new Set([
      ...diskSubagents
        .filter((child) => child.state !== 'SUBAGENT_STATE_KILLED')
        .map((child) => child.conversationId),
      ...swarmMembers
        .filter(
          (member) => !member.killed && member.phase === 'RUNNING' && member.wakeMode !== 'mentions'
        )
        .map((member) => member.conversationId),
      ...pane.children.keys()
    ])
    const tails: AntigravityPaneChildState['transcriptTails'] = new Map()
    for (const id of ids) {
      if (!batch.wanted()) {
        return undefined
      }
      if (
        id === pane.rootConversationId ||
        pane.retiredChildren.has(id) ||
        pane.children.get(id)?.hookState === 'done'
      ) {
        continue
      }
      const tail = await readAntigravityChildTranscriptTail(pane.rootBrainDir, id, cache, batch)
      if (!batch.wanted()) {
        return undefined
      }
      if (tail && !pane.retiredChildren.has(id)) {
        tails.set(id, tail)
      }
      // Parsed records own their small projection now; release buffers before reading the next child.
      batch.unreserve(Number.MAX_SAFE_INTEGER)
    }
    return batch.wanted() ? { pane, diskSubagents, swarmMembers, tails, leadModel } : undefined
  } finally {
    batch.release()
  }
}

export function pollAntigravityTranscriptStatus(
  state: HookListenerState,
  original: AgentHookEventPayload,
  reads: AntigravityTranscriptPollReads | undefined
): AgentHookEventPayload | undefined {
  const pane = state.antigravityChildWorkByPaneKey.get(original.paneKey)
  if (!reads || pane !== reads.pane) {
    return undefined
  }
  pane.leadModel ??= reads.leadModel
  pane.discoversChildren = false
  pane.diskSubagents = reads.diskSubagents
  pane.swarmMembers = reads.swarmMembers
  pane.transcriptTails = reads.tails
  const payload = buildAntigravityFoldedStatusPayload(state, original.paneKey, pane, Date.now())
  if (!payload) {
    return undefined
  }
  if (payload.state === 'done' && pane.leadState === 'done') {
    if (pane.rootTranscriptPath) {
      state.antigravityCompletedTranscriptByPaneKey.set(original.paneKey, pane.rootTranscriptPath)
    }
  }
  return { ...original, hookEventName: undefined, payload }
}
